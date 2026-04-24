import argparse
import json
import re
import zipfile
import xml.etree.ElementTree as ET


NS = {
    "a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
}


def col_to_index(col_letters: str) -> int:
    value = 0
    for char in col_letters:
        value = value * 26 + ord(char.upper()) - 64
    return value


def read_shared_strings(zf: zipfile.ZipFile):
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    strings = []
    for si in root.findall("a:si", NS):
        strings.append("".join(t.text or "" for t in si.iterfind(".//a:t", NS)))
    return strings


def cell_value(cell, shared_strings):
    value_node = cell.find("a:v", NS)
    if value_node is None:
        return ""
    raw = value_node.text or ""
    cell_type = cell.attrib.get("t")
    if cell_type == "s":
        return shared_strings[int(raw)]
    if cell_type == "b":
        return "1" if raw == "1" else "0"
    return raw


def load_sheet_names(zf: zipfile.ZipFile):
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rel_map = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels}
    sheets = []
    for sheet in workbook.find("a:sheets", NS):
        rid = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
        sheets.append((sheet.attrib["name"], "xl/" + rel_map[rid]))
    return sheets


def sheet_to_rows(zf: zipfile.ZipFile, sheet_path: str, shared_strings):
    root = ET.fromstring(zf.read(sheet_path))
    rows = []
    for row in root.find("a:sheetData", NS).findall("a:row", NS):
        values = []
        next_col = 1
        for cell in row.findall("a:c", NS):
            ref = cell.attrib["r"]
            match = re.match(r"([A-Z]+)(\d+)", ref)
            if not match:
                continue
            col_index = col_to_index(match.group(1))
            while next_col < col_index:
                values.append("")
                next_col += 1
            values.append(cell_value(cell, shared_strings))
            next_col += 1
        while values and values[-1] == "":
            values.pop()
        rows.append(values)
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_path")
    parser.add_argument("output_path")
    args = parser.parse_args()

    with zipfile.ZipFile(args.input_path) as zf:
        shared_strings = read_shared_strings(zf)
        workbook_json = {}
        for sheet_name, sheet_path in load_sheet_names(zf):
            workbook_json[sheet_name] = sheet_to_rows(zf, sheet_path, shared_strings)

    with open(args.output_path, "w", encoding="utf-8") as handle:
        json.dump(workbook_json, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


if __name__ == "__main__":
    main()
