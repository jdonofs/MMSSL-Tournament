import argparse
import copy
import re
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict


NS = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
ET.register_namespace("", NS["a"])


def col_letter(idx: int) -> str:
    out = []
    while idx:
        idx, rem = divmod(idx - 1, 26)
        out.append(chr(65 + rem))
    return "".join(reversed(out))


def parse_baseball_ip(value):
    if value in (None, "", 0, "0"):
        return 0
    text = str(value)
    if "." in text:
        whole, frac = text.split(".", 1)
        return int(whole) * 3 + int(frac[:1] or "0")
    return int(float(text)) * 3


def outs_to_display(outs: int):
    return "" if outs == 0 else f"{outs // 3}.{outs % 3}" if outs % 3 else str(outs // 3)


def outs_to_decimal_ip(outs: int):
    return outs / 3 if outs else 0


def num(value):
    if value in (None, ""):
        return 0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text or text == "#VALUE!":
        return 0
    return float(text)


def parse_sheet(xml_bytes):
    root = ET.fromstring(xml_bytes)
    rows = {}
    cells = {}
    for row in root.find("a:sheetData", NS).findall("a:row", NS):
        rnum = int(row.attrib["r"])
        rows[rnum] = row
        row_cells = {}
        for cell in row.findall("a:c", NS):
            ref = cell.attrib["r"]
            row_cells[re.match(r"[A-Z]+", ref).group(0)] = cell
            cells[ref] = cell
        rows[rnum] = row_cells
    return root, rows, cells


def read_shared_strings(zf):
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    strings = []
    for si in root.findall("a:si", NS):
        strings.append("".join(t.text or "" for t in si.iterfind(".//a:t", NS)))
    return root, strings


def cached_value(cell, shared_strings):
    v = cell.find("a:v", NS)
    if v is None:
        return None
    if cell.attrib.get("t") == "s":
        return shared_strings[int(v.text)]
    return v.text


def row_value(row, col):
    cell = row.get(col)
    if cell is None:
        return None
    return cached_value(cell, SHARED_STRINGS)


def set_cached_value(cell, value, value_type=None):
    v = cell.find("a:v", NS)
    if value in (None, ""):
        if v is not None:
            cell.remove(v)
        if value_type == "str":
            cell.attrib["t"] = "str"
        elif cell.attrib.get("t") in {"str", "s"}:
            cell.attrib.pop("t", None)
        return
    if v is None:
        v = ET.SubElement(cell, f"{{{NS['a']}}}v")
    if value_type == "str":
        cell.attrib["t"] = "str"
        v.text = str(value)
    else:
        if "t" in cell.attrib:
            cell.attrib.pop("t", None)
        if isinstance(value, float):
            v.text = repr(value)
        else:
            v.text = str(value)


def update_formula(cell, formula_text=None, cached=None, value_type=None):
    f = cell.find("a:f", NS)
    if formula_text is not None and f is not None:
        f.text = formula_text
    set_cached_value(cell, cached, value_type)


def safe_div(numerator, denominator):
    return 0 if denominator == 0 else numerator / denominator


def batting_rate(stats):
    ab = stats["AB"]
    h = stats["H"]
    doubles = stats["2B"]
    triples = stats["3B"]
    hr = stats["HR"]
    bb = stats["BB"]
    hbp = stats["HBP"]
    sf = stats["SF"]
    singles = h - doubles - triples - hr
    avg = safe_div(h, ab)
    obp = safe_div(h + bb + hbp, ab + bb + hbp + sf)
    slg = safe_div(singles + 2 * doubles + 3 * triples + 4 * hr, ab)
    return avg, obp, slg, obp + slg


def pitch_rate(er, hits_allowed, bb, outs):
    raw_ip = outs_to_decimal_ip(outs)
    era3 = 0 if raw_ip == 0 else er * 3 / raw_ip
    whip = 0 if raw_ip == 0 else (hits_allowed + bb) / raw_ip
    return era3, whip


def game_row_from_index(game_index):
    return 4 + (game_index - 1)


def scorebook_start_from_index(game_index):
    return 1 + (game_index - 1) * 49


def data_batting_base(game_index):
    return 4 + (game_index - 1) * 18


def data_pitching_base(game_index):
    return 4 + (game_index - 1) * 12


def build_scorebook_records(scorebook_rows):
    games = []
    batting_rows = []
    pitching_rows = []

    for game_index in range(1, 12):
        start = scorebook_start_from_index(game_index)
        meta = scorebook_rows.get(start + 1, {})
        game_id = row_value(meta, "F")
        team_a = row_value(meta, "N")
        team_b = row_value(meta, "R")
        if not game_id:
            continue

        score_a = num(row_value(scorebook_rows.get(start + 3, {}), "K"))
        score_b = num(row_value(scorebook_rows.get(start + 4, {}), "K"))
        winner = row_value(meta, "V")
        loser = team_b if winner == team_a else team_a if winner == team_b else ""

        game = {
            "index": game_index,
            "start": start,
            "game_id": game_id,
            "team_a": team_a,
            "team_b": team_b,
            "winner": winner or "",
            "loser": loser or "",
            "score_a": int(score_a),
            "score_b": int(score_b),
        }
        game_batting_rows = []
        game_pitching_rows = []

        for side, owner, start_row in (("A", team_a, start + 8), ("B", team_b, start + 29)):
            for offset in range(9):
                row_num = start_row + offset
                row = scorebook_rows.get(row_num, {})
                batter = row_value(row, "B")
                if not batter:
                    continue
                game_batting_rows.append(
                    {
                        "game_id": game_id,
                        "owner": owner,
                        "character": batter,
                        "order": offset + 1,
                        "AB": int(num(row_value(row, "M"))),
                        "R": int(num(row_value(row, "N"))),
                        "H": int(num(row_value(row, "O"))),
                        "2B": int(num(row_value(row, "P"))),
                        "3B": int(num(row_value(row, "Q"))),
                        "HR": int(num(row_value(row, "R"))),
                        "RBI": int(num(row_value(row, "S"))),
                        "BB": int(num(row_value(row, "T"))),
                        "SO": int(num(row_value(row, "U"))),
                        "HBP": int(num(row_value(row, "V"))),
                        "SF": int(num(row_value(row, "W"))),
                        "SH": int(num(row_value(row, "X"))),
                    }
                )

        for side, owner, start_row in (("A", team_a, start + 20), ("B", team_b, start + 41)):
            side_rows = []
            for offset in range(6):
                row_num = start_row + offset
                row = scorebook_rows.get(row_num, {})
                pitcher = row_value(row, "B")
                if not pitcher:
                    continue
                outs = parse_baseball_ip(row_value(row, "C"))
                side_rows.append(
                    {
                        "scorebook_row": row_num,
                        "game_id": game_id,
                        "owner": owner,
                        "pitcher": pitcher,
                        "outs": outs,
                        "H": int(num(row_value(row, "D"))),
                        "R": int(num(row_value(row, "E"))),
                        "ER": int(num(row_value(row, "F"))),
                        "BB": int(num(row_value(row, "G"))),
                        "SO": int(num(row_value(row, "H"))),
                        "HRA": int(num(row_value(row, "I"))),
                        "PA": int(num(row_value(row, "O"))),
                    }
                )

            active = [r for r in side_rows if r["pitcher"] not in ("0", 0, None, "") and r["outs"] > 0]
            for row in side_rows:
                row["W"] = 0
                row["L"] = 0
                row["SV"] = 0
                row["SHO"] = 0
                row["CG"] = 0

            if active:
                if len(active) == 1:
                    active[0]["CG"] = 1
                    opp_runs = game["score_b"] if owner == team_a else game["score_a"]
                    if opp_runs == 0:
                        active[0]["SHO"] = 1

                if game["winner"] == owner:
                    win_pitcher = max(active, key=lambda r: (r["outs"], -r["scorebook_row"]))
                    win_pitcher["W"] = 1
                    if len(active) > 1:
                        last_pitcher = active[-1]
                        margin = abs(game["score_a"] - game["score_b"])
                        if last_pitcher is not win_pitcher and margin <= 3 and last_pitcher["outs"] >= 3:
                            last_pitcher["SV"] = 1
                elif game["loser"] == owner:
                    loss_pitcher = max(active, key=lambda r: (r["R"], -r["scorebook_row"]))
                    loss_pitcher["L"] = 1

            game_pitching_rows.extend(side_rows)

        if not game["winner"] and game["score_a"] == 0 and game["score_b"] == 0:
            if sum(r["AB"] + r["R"] + r["H"] for r in game_batting_rows) == 0 and sum(r["PA"] for r in game_pitching_rows) == 0:
                continue

        games.append(game)
        batting_rows.extend(game_batting_rows)
        pitching_rows.extend(game_pitching_rows)

    return games, batting_rows, pitching_rows


def update_data_sheet(sheet_rows, scorebook_rows, games, batting_rows, pitching_rows):
    games_by_index = {g["index"]: g for g in games}
    batting_by_game = defaultdict(list)
    pitching_by_game = defaultdict(list)
    for row in batting_rows:
        batting_by_game[row["game_id"]].append(row)
    for row in pitching_rows:
        pitching_by_game[row["game_id"]].append(row)

    for game_index in range(1, 16):
        game = games_by_index.get(game_index)
        data_row = game_row_from_index(game_index)
        if not game:
            if data_row in sheet_rows:
                for col in ("H", "J", "K", "L", "M", "N", "O", "P"):
                    if col in sheet_rows[data_row]:
                        set_cached_value(sheet_rows[data_row][col], None, "str" if col in {"H", "J", "K", "L", "M"} else None)
            batting_base = data_batting_base(game_index)
            for row_num in range(batting_base, batting_base + 18):
                row = sheet_rows.get(row_num)
                if not row:
                    continue
                for col in ("S", "T", "U", "V", "W", "X", "Y", "Z", "AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH"):
                    if col in row:
                        set_cached_value(row[col], None, "str" if col in {"S", "T", "U"} else None)
            pitching_base = data_pitching_base(game_index)
            for row_num in range(pitching_base, pitching_base + 12):
                row = sheet_rows.get(row_num)
                if not row:
                    continue
                for col in ("AJ", "AK", "AL", "AM", "AN", "AO", "AP", "AQ", "AR", "AS", "AT", "AU", "AV", "AW", "AX", "AY"):
                    if col in row:
                        set_cached_value(row[col], None, "str" if col in {"AK", "AL", "AM"} else None)
            continue

        start = game["start"]

        for col, formula, value, value_type in (
            ("H", f"Scorebook!$F${start + 1}", game["game_id"], "str"),
            ("J", f"Scorebook!$N${start + 1}", game["team_a"], "str"),
            ("K", f"Scorebook!$R${start + 1}", game["team_b"], "str"),
            ("L", f"Scorebook!$V${start + 1}", game["winner"], "str"),
            ("M", f'IF(L{data_row}="","",IF(L{data_row}=J{data_row},K{data_row},J{data_row}))', game["loser"], "str"),
            ("N", f"Scorebook!$K${start + 3}", game["score_a"], None),
            ("O", f"Scorebook!$K${start + 4}", game["score_b"], None),
            ("P", f'IF(H{data_row}="","",--(L{data_row}<>""))', 1 if game["winner"] else "", None),
        ):
            cell = sheet_rows[data_row][col]
            update_formula(cell, formula, value, value_type)

        batting_base = data_batting_base(game_index)
        team_a_rows = [r for r in batting_rows if r["game_id"] == game["game_id"] and r["owner"] == game["team_a"]]
        team_b_rows = [r for r in batting_rows if r["game_id"] == game["game_id"] and r["owner"] == game["team_b"]]
        for offset, source in enumerate(team_a_rows + team_b_rows):
            row_num = batting_base + offset
            owner_formula = f"Scorebook!${'N' if offset < 9 else 'R'}${start + 1}"
            owner_value = game["team_a"] if offset < 9 else game["team_b"]
            update_formula(sheet_rows[row_num]["S"], f"Scorebook!$F${start + 1}", game["game_id"], "str")
            update_formula(sheet_rows[row_num]["T"], owner_formula, owner_value, "str")
            set_cached_value(sheet_rows[row_num]["U"], source["character"], "str")
            set_cached_value(sheet_rows[row_num]["V"], source["order"])
            for col, key in (
                ("W", "AB"),
                ("X", "R"),
                ("Y", "H"),
                ("Z", "2B"),
                ("AA", "3B"),
                ("AB", "HR"),
                ("AC", "RBI"),
                ("AD", "BB"),
                ("AE", "SO"),
                ("AF", "HBP"),
                ("AG", "SF"),
                ("AH", "SH"),
            ):
                set_cached_value(sheet_rows[row_num][col], source[key])

        pitching_base = data_pitching_base(game_index)
        team_a_pitch = [r for r in pitching_rows if r["game_id"] == game["game_id"] and r["owner"] == game["team_a"]]
        team_b_pitch = [r for r in pitching_rows if r["game_id"] == game["game_id"] and r["owner"] == game["team_b"]]
        for side_offset, team_pitch, owner_value in ((0, team_a_pitch, game["team_a"]), (6, team_b_pitch, game["team_b"])):
            for offset in range(6):
                row_num = pitching_base + side_offset + offset
                row = sheet_rows.get(row_num)
                if not row:
                    continue
                source = team_pitch[offset] if offset < len(team_pitch) else None
                update_formula(row["AK"], f"Scorebook!$F${start + 1}", game["game_id"], "str")
                update_formula(row["AL"], f"Scorebook!${'N' if side_offset == 0 else 'R'}${start + 1}", owner_value, "str")
                if source is None:
                    if "AM" in row:
                        set_cached_value(row["AM"], None, "str")
                    for col in ("AN", "AO", "AP", "AQ", "AR", "AS", "AT", "AU", "AV", "AW", "AX", "AY", "AJ"):
                        if col in row:
                            set_cached_value(row[col], None)
                    continue
                set_cached_value(row["AM"], source["pitcher"], "str")
                set_cached_value(row["AN"], outs_to_decimal_ip(source["outs"]) if source["outs"] else None)
                for col, key in (
                    ("AO", "H"),
                    ("AP", "R"),
                    ("AQ", "ER"),
                    ("AR", "BB"),
                    ("AS", "SO"),
                    ("AT", "HRA"),
                    ("AU", "W"),
                    ("AV", "L"),
                    ("AW", "SV"),
                    ("AX", "SHO"),
                    ("AY", "CG"),
                    ("AJ", "PA"),
                ):
                    set_cached_value(row[col], source[key])


def aggregate_scorebook(games, batting_rows, pitching_rows):
    games_by_id = {g["game_id"]: g for g in games}
    batting_by_player_game = defaultdict(lambda: defaultdict(int))
    pitching_by_player_game = defaultdict(lambda: defaultdict(int))
    batting_by_char_game = defaultdict(lambda: defaultdict(int))
    pitching_by_char_game = defaultdict(lambda: defaultdict(int))

    for row in batting_rows:
        game = games_by_id[row["game_id"]]
        player_key = (row["owner"], row["game_id"])
        char_key = (row["owner"], row["character"], row["game_id"])
        for key in ("AB", "R", "H", "2B", "3B", "HR", "RBI", "BB", "SO", "HBP", "SF", "SH"):
            batting_by_player_game[player_key][key] += row[key]
            batting_by_char_game[char_key][key] += row[key]
        batting_by_player_game[player_key]["RS"] = game["score_a"] if row["owner"] == game["team_a"] else game["score_b"]
        batting_by_player_game[player_key]["RA"] = game["score_b"] if row["owner"] == game["team_a"] else game["score_a"]
        batting_by_player_game[player_key]["W"] = 1 if game["winner"] == row["owner"] else 0
        batting_by_player_game[player_key]["L"] = 1 if game["loser"] == row["owner"] else 0

    for row in pitching_rows:
        player_key = (row["owner"], row["game_id"])
        char_key = (row["owner"], row["pitcher"], row["game_id"])
        for key in ("H", "R", "ER", "BB", "SO", "HRA", "W", "L", "SV", "SHO", "CG", "PA"):
            pitching_by_player_game[player_key][key] += row[key]
            pitching_by_char_game[char_key][key] += row[key]
        pitching_by_player_game[player_key]["outs"] += row["outs"]
        pitching_by_char_game[char_key]["outs"] += row["outs"]

    return games_by_id, batting_by_player_game, pitching_by_player_game, batting_by_char_game, pitching_by_char_game


def update_current_player_stats(sheet_rows, games, batting_by_player_game, pitching_by_player_game):
    for game_index in range(1, 12):
        row_a = 4 + (game_index - 1) * 2
        row_b = row_a + 1
        game = next((g for g in games if g["index"] == game_index), None)
        if game is None:
            for row_num in (row_a, row_b):
                row = sheet_rows.get(row_num)
                if not row:
                    continue
                if "A" in row:
                    set_cached_value(row["A"], None, "str")
                if "B" in row:
                    set_cached_value(row["B"], None, "str")
            continue
        if row_a in sheet_rows:
            set_cached_value(sheet_rows[row_a]["A"], game["team_a"], "str")
            set_cached_value(sheet_rows[row_a]["B"], game["game_id"], "str")
        if row_b in sheet_rows:
            set_cached_value(sheet_rows[row_b]["A"], game["team_b"], "str")
            set_cached_value(sheet_rows[row_b]["B"], game["game_id"], "str")

    for row_num in range(4, 34):
        row = sheet_rows.get(row_num)
        if not row or "A" not in row or "B" not in row:
            continue
        player = cached_value(row["A"], SHARED_STRINGS)
        game_id = cached_value(row["B"], SHARED_STRINGS)
        if not player or not game_id:
            continue

        bat = batting_by_player_game.get((player, game_id), defaultdict(int))
        pit = pitching_by_player_game.get((player, game_id), defaultdict(int))
        avg, obp, slg, ops = batting_rate(bat)
        era3, whip = pitch_rate(pit["ER"], pit["H"], pit["BB"], pit["outs"])
        values = {
            "C": bat["W"],
            "D": bat["L"],
            "E": bat["RS"],
            "F": bat["RA"],
            "G": bat["AB"],
            "H": bat["H"],
            "I": avg,
            "J": obp,
            "K": slg,
            "L": ops,
            "M": outs_to_display(pit["outs"]) if pit["outs"] else 0,
            "N": pit["H"],
            "O": pit["ER"],
            "P": pit["BB"],
            "Q": pit["SO"],
            "R": era3,
            "S": whip,
            "T": pit["SV"],
            "U": pit["SHO"],
            "V": pit["CG"],
            "W": bat["R"],
            "X": bat["2B"],
            "Y": bat["3B"],
            "Z": bat["HR"],
            "AA": bat["RBI"],
            "AB": bat["BB"],
            "AC": bat["SO"],
            "AD": bat["HBP"],
            "AE": bat["SF"],
            "AF": bat["SH"],
            "AG": pit["R"],
            "AH": pit["HRA"],
            "AI": pit["PA"],
        }
        for col, value in values.items():
            if col in row:
                set_cached_value(row[col], value)


def update_current_char_stats(sheet_rows, batting_rows, batting_by_char_game, pitching_by_char_game):
    for idx, source in enumerate(batting_rows, start=4):
        row = sheet_rows.get(idx)
        if not row:
            continue
        set_cached_value(row["A"], source["owner"], "str")
        set_cached_value(row["B"], source["character"], "str")
        set_cached_value(row["C"], source["game_id"], "str")

    for row_num, row in sheet_rows.items():
        if row_num < 4 or "A" not in row or "B" not in row or "C" not in row:
            continue
        owner = cached_value(row["A"], SHARED_STRINGS)
        character = cached_value(row["B"], SHARED_STRINGS)
        game_id = cached_value(row["C"], SHARED_STRINGS)
        if not owner or not character or not game_id:
            continue

        bat = batting_by_char_game.get((owner, character, game_id), defaultdict(int))
        pit = pitching_by_char_game.get((owner, character, game_id), defaultdict(int))
        avg = safe_div(bat["H"], bat["AB"])
        era3, whip = pitch_rate(pit["ER"], pit["H"], pit["BB"], pit["outs"])
        updates = {
            "D": bat["AB"],
            "E": bat["H"],
            "F": avg,
            "G": bat["HR"],
            "H": bat["RBI"],
            "I": outs_to_display(pit["outs"]) if pit["outs"] else 0,
            "J": pit["ER"],
            "K": era3 if pit["outs"] else None,
            "N": bat["R"],
            "O": bat["2B"],
            "P": bat["3B"],
            "Q": bat["BB"],
            "R": bat["SO"],
            "S": bat["HBP"],
            "T": bat["SF"],
            "U": bat["SH"],
            "V": pit["H"],
            "W": pit["R"],
            "X": pit["BB"],
            "Y": pit["SO"],
            "Z": pit["HRA"],
            "AA": pit["SV"],
            "AB": pit["SHO"],
            "AC": pit["CG"],
            "AD": whip,
            "AE": pit["PA"],
        }
        for col, value in updates.items():
            if col in row:
                set_cached_value(row[col], value)


def update_current_player_aggregate(sheet_rows, batting_by_player_game, pitching_by_player_game):
    games_by_player = defaultdict(set)
    bat_totals = defaultdict(lambda: defaultdict(int))
    pit_totals = defaultdict(lambda: defaultdict(int))

    for (player, game_id), stats in batting_by_player_game.items():
        games_by_player[player].add(game_id)
        for key, value in stats.items():
            bat_totals[player][key] += value

    for (player, game_id), stats in pitching_by_player_game.items():
        for key, value in stats.items():
            pit_totals[player][key] += value

    for row_num in range(4, 10):
        row = sheet_rows.get(row_num)
        if not row or "A" not in row:
            continue
        player = cached_value(row["A"], SHARED_STRINGS)
        if not player:
            continue
        bat = bat_totals[player]
        avg, obp, slg, ops = batting_rate(bat)
        updates = {
            "B": len(games_by_player[player]),
            "C": bat["W"],
            "D": bat["L"],
            "E": bat["RS"],
            "F": bat["RA"],
            "G": bat["RS"] - bat["RA"],
            "H": bat["AB"],
            "I": bat["H"],
            "J": avg,
            "K": obp,
            "L": slg,
            "M": ops,
            "O": bat["R"],
            "P": bat["2B"],
            "Q": bat["3B"],
            "R": bat["HR"],
            "S": bat["RBI"],
            "T": bat["BB"],
            "U": bat["SO"],
            "V": bat["HBP"],
            "W": bat["SF"],
            "X": bat["SH"],
        }
        for col, value in updates.items():
            if col in row:
                set_cached_value(row[col], value)

    for row_num in range(15, 21):
        row = sheet_rows.get(row_num)
        if not row or "A" not in row:
            continue
        player = cached_value(row["A"], SHARED_STRINGS)
        if not player:
            continue
        pit = pit_totals[player]
        era3, whip = pitch_rate(pit["ER"], pit["H"], pit["BB"], pit["outs"])
        updates = {
            "B": outs_to_display(pit["outs"]) if pit["outs"] else 0,
            "C": pit["H"],
            "D": pit["ER"],
            "E": pit["BB"],
            "F": pit["SO"],
            "G": era3,
            "H": whip,
            "I": pit["W"],
            "J": pit["L"],
            "K": pit["SV"],
            "L": pit["SHO"],
            "M": pit["CG"],
            "N": pit["R"],
            "O": pit["HRA"],
            "P": pit["PA"],
        }
        for col, value in updates.items():
            if col in row:
                set_cached_value(row[col], value)


def update_current_character_aggregate(sheet_rows, batting_rows, pitching_rows):
    bat_totals = defaultdict(lambda: defaultdict(int))
    pit_totals = defaultdict(lambda: defaultdict(int))
    owners_by_char = defaultdict(set)

    for row in batting_rows:
        char = row["character"]
        owners_by_char[char].add(row["owner"])
        for key in ("AB", "R", "H", "2B", "3B", "HR", "RBI", "BB", "SO", "HBP", "SF", "SH"):
            bat_totals[char][key] += row[key]

    for row in pitching_rows:
        char = row["pitcher"]
        for key in ("H", "R", "ER", "BB", "SO", "HRA", "SV", "SHO", "CG", "PA"):
            pit_totals[char][key] += row[key]
        pit_totals[char]["outs"] += row["outs"]

    for row_num, row in sheet_rows.items():
        if row_num < 4 or "A" not in row:
            continue
        char = cached_value(row["A"], SHARED_STRINGS)
        if not char:
            continue
        bat = bat_totals[char]
        pit = pit_totals[char]
        avg = safe_div(bat["H"], bat["AB"])
        era3, whip = pitch_rate(pit["ER"], pit["H"], pit["BB"], pit["outs"])
        updates = {
            "C": bat["AB"],
            "D": bat["H"],
            "E": avg,
            "F": bat["HR"],
            "G": bat["RBI"],
            "K": bat["R"],
            "L": bat["2B"],
            "M": bat["3B"],
            "N": bat["BB"],
            "O": bat["SO"],
            "P": bat["HBP"],
            "S": bat["SF"],
            "T": bat["SH"],
            "U": outs_to_display(pit["outs"]) if pit["outs"] else 0,
            "V": pit["ER"],
            "W": era3 if pit["outs"] else 0,
            "X": pit["H"],
            "Y": pit["R"],
            "Z": pit["BB"],
            "AA": pit["SO"],
            "AB": pit["HRA"],
            "AC": pit["SV"],
            "AD": pit["SHO"],
            "AE": pit["CG"],
            "AF": whip,
            "AG": pit["PA"],
        }
        for col, value in updates.items():
            if col in row:
                set_cached_value(row[col], value)


def update_tourney_summary(sheet_rows, batting_by_player_game, pitching_by_player_game, batting_by_char_game, pitching_by_char_game):
    bat_totals = defaultdict(lambda: defaultdict(int))
    pit_totals = defaultdict(lambda: defaultdict(int))
    games_by_player = defaultdict(set)

    for (player, game_id), stats in batting_by_player_game.items():
        games_by_player[player].add(game_id)
        for key, value in stats.items():
            bat_totals[player][key] += value

    for (player, game_id), stats in pitching_by_player_game.items():
        for key, value in stats.items():
            pit_totals[player][key] += value

    for row_num in range(5, 11):
        row = sheet_rows.get(row_num)
        if not row or "A" not in row:
            continue
        player = cached_value(row["A"], SHARED_STRINGS)
        if not player:
            continue
        bat = bat_totals[player]
        pit = pit_totals[player]
        avg, obp, slg, ops = batting_rate(bat)
        era3, whip = pitch_rate(pit["ER"], pit["H"], pit["BB"], pit["outs"])
        updates = {
            "B": len(games_by_player[player]),
            "C": bat["W"],
            "D": bat["L"],
            "E": bat["RS"],
            "F": bat["RA"],
            "G": bat["RS"] - bat["RA"],
            "H": bat["AB"],
            "I": bat["H"],
            "J": avg,
            "K": obp,
            "L": slg,
            "M": ops,
            "N": era3,
            "O": whip,
        }
        for col, value in updates.items():
            if col in row:
                set_cached_value(row[col], value)

    owner_char_bat = defaultdict(lambda: defaultdict(int))
    owner_char_pit = defaultdict(lambda: defaultdict(int))
    for (owner, char, _game_id), stats in batting_by_char_game.items():
        for key in ("AB", "H", "HR", "RBI"):
            owner_char_bat[(owner, char)][key] += stats[key]
    for (owner, char, _game_id), stats in pitching_by_char_game.items():
        owner_char_pit[(owner, char)]["ER"] += stats["ER"]
        owner_char_pit[(owner, char)]["outs"] += stats["outs"]

    for row_num in range(91, 140):
        row = sheet_rows.get(row_num)
        if not row or "A" not in row or "B" not in row:
            continue
        owner = cached_value(row["A"], SHARED_STRINGS)
        char = cached_value(row["B"], SHARED_STRINGS)
        if not owner or not char:
            continue
        bat = owner_char_bat[(owner, char)]
        pit = owner_char_pit[(owner, char)]
        era3 = 0 if pit["outs"] == 0 else pit["ER"] * 3 / outs_to_decimal_ip(pit["outs"])
        updates = {
            "C": bat["AB"],
            "D": bat["H"],
            "E": safe_div(bat["H"], bat["AB"]),
            "F": bat["HR"],
            "G": bat["RBI"],
            "H": outs_to_display(pit["outs"]) if pit["outs"] else 0,
            "I": pit["ER"],
            "J": era3 if pit["outs"] else None,
        }
        for col, value in updates.items():
            if col in row:
                set_cached_value(row[col], value)


def replace_era_formulas(root):
    for formula in root.iterfind(".//a:f", NS):
        if formula.text:
            formula.text = formula.text.replace("*9/", "*3/")


def set_full_recalc(workbook_root):
    calc = workbook_root.find("a:calcPr", NS)
    if calc is None:
        calc = ET.SubElement(workbook_root, f"{{{NS['a']}}}calcPr")
    calc.attrib["calcCompleted"] = "0"
    calc.attrib["fullCalcOnLoad"] = "1"
    calc.attrib["forceFullCalc"] = "1"
    calc.attrib["calcMode"] = "auto"


def write_xml(root):
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_path")
    parser.add_argument("output_path")
    args = parser.parse_args()

    with zipfile.ZipFile(args.input_path, "r") as zin:
        files = {name: zin.read(name) for name in zin.namelist()}

    with zipfile.ZipFile(args.input_path, "r") as zin:
        shared_root, shared_strings = read_shared_strings(zin)
        global SHARED_STRINGS
        SHARED_STRINGS = shared_strings

    workbook_root = ET.fromstring(files["xl/workbook.xml"])
    scorebook_root, scorebook_rows, _ = parse_sheet(files["xl/worksheets/sheet6.xml"])
    data_root, data_rows, _ = parse_sheet(files["xl/worksheets/sheet8.xml"])
    cps_root, cps_rows, _ = parse_sheet(files["xl/worksheets/sheet9.xml"])
    ccs_root, ccs_rows, _ = parse_sheet(files["xl/worksheets/sheet10.xml"])
    ts_root, ts_rows, _ = parse_sheet(files["xl/worksheets/sheet11.xml"])
    cp_root, cp_rows, _ = parse_sheet(files["xl/worksheets/sheet18.xml"])
    cc_root, cc_rows, _ = parse_sheet(files["xl/worksheets/sheet19.xml"])

    games, batting_rows, pitching_rows = build_scorebook_records(scorebook_rows)
    games_by_id, batting_by_player_game, pitching_by_player_game, batting_by_char_game, pitching_by_char_game = aggregate_scorebook(
        games, batting_rows, pitching_rows
    )

    for text_node in shared_root.iterfind(".//a:t", NS):
        if text_node.text == "ERA":
            text_node.text = "ERA/3"

    update_data_sheet(data_rows, scorebook_rows, games, batting_rows, pitching_rows)

    for pitch in pitching_rows:
        row_num = pitch["scorebook_row"]
        row = scorebook_rows[row_num]
        set_cached_value(row["C"], outs_to_display(pitch["outs"]) if pitch["outs"] else None)
        set_cached_value(row["D"], pitch["H"])
        set_cached_value(row["E"], pitch["R"])
        set_cached_value(row["F"], pitch["ER"])
        set_cached_value(row["G"], pitch["BB"])
        set_cached_value(row["H"], pitch["SO"])
        set_cached_value(row["I"], pitch["HRA"])
        set_cached_value(row["J"], pitch["W"])
        set_cached_value(row["K"], pitch["L"])
        set_cached_value(row["L"], pitch["SV"])
        set_cached_value(row["M"], pitch["SHO"])
        set_cached_value(row["N"], pitch["CG"])
        set_cached_value(row["O"], pitch["PA"] if pitch["PA"] else None)

    update_current_player_stats(cps_rows, games, batting_by_player_game, pitching_by_player_game)
    update_current_char_stats(ccs_rows, batting_rows, batting_by_char_game, pitching_by_char_game)
    update_current_player_aggregate(cp_rows, batting_by_player_game, pitching_by_player_game)
    update_current_character_aggregate(cc_rows, batting_rows, pitching_rows)
    update_tourney_summary(ts_rows, batting_by_player_game, pitching_by_player_game, batting_by_char_game, pitching_by_char_game)

    for root in (scorebook_root, data_root, cps_root, ccs_root, ts_root, cp_root, cc_root):
        replace_era_formulas(root)
    set_full_recalc(workbook_root)

    files["xl/sharedStrings.xml"] = write_xml(shared_root)
    files["xl/workbook.xml"] = write_xml(workbook_root)
    files["xl/worksheets/sheet6.xml"] = write_xml(scorebook_root)
    files["xl/worksheets/sheet8.xml"] = write_xml(data_root)
    files["xl/worksheets/sheet9.xml"] = write_xml(cps_root)
    files["xl/worksheets/sheet10.xml"] = write_xml(ccs_root)
    files["xl/worksheets/sheet11.xml"] = write_xml(ts_root)
    files["xl/worksheets/sheet18.xml"] = write_xml(cp_root)
    files["xl/worksheets/sheet19.xml"] = write_xml(cc_root)

    for sheet_name in ("xl/worksheets/sheet13.xml", "xl/worksheets/sheet14.xml"):
        root = ET.fromstring(files[sheet_name])
        replace_era_formulas(root)
        files[sheet_name] = write_xml(root)

    with zipfile.ZipFile(args.output_path, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for name, content in files.items():
            zout.writestr(name, content)


if __name__ == "__main__":
    main()
