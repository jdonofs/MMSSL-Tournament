# This is a sample Python script.

# Press Shift+F10 to execute it or replace it with your code.
# Press Double Shift to search everywhere for classes, files, tool windows, actions, and settings.
import tkinter as tk
from tkinter import ttk
from tkinter.messagebox import askyesno, showerror, showinfo
import dolphin_memory_engine as DMM
from pathlib import Path
import pygetwindow as gw
import json
import keyboard as kb
import time
from mii import MiiDatabase, MiiParser, MiiType

# Safe delay times that work. Faster times may work but if things start to break, revert to 0.05, 0.05.
INPUT_DELAY = 0.05
RELEASE_DELAY = 0.05


with open("teams.json") as json_data:
    file = json.load(json_data)
    json_data.close()
teams = file["teams"]
team_names = file["team_names"]
print(team_names)

with open("options.json") as json_data:
    file = json.load(json_data)
    json_data.close()
options = file
options.setdefault("DefaultAwayCaptainID", 0)
options.setdefault("DefaultHomeCaptainID", 1)
options.setdefault("AutoStart", True)


def str_to_hex(str):
    hx = 0x0
    for c in str:
        hx *= 0x10
        if c >= "a" and c <= "f":
            n = (ord(c) - ord("a")) + 10
            hx += n
        elif c >= "0" and c <= "9":
            n = ord(c) - ord("0")
            hx += n
    return hx


mii_list = []
try:
    db = MiiDatabase(Path(options["MiiDBPath"]), MiiType.WII_PLAZA)

    for mii in db:
        v = int(str_to_hex(mii.mii_id.hex()))
        if v >= 0x80000000 and v < 0x90000000:
            mii_list.append(mii)
            print(mii.name)
except:
    print("File error")

charList = [
    "Mario",
    "Luigi",
    "Donkey Kong",
    "Diddy Kong",
    "Peach",
    "Daisy",
    "Green Yoshi",
    "Baby Mario",
    "Baby Luigi",
    "Bowser",
    "Wario",
    "Waluigi",
    "Green Koopa Troopa",
    "Red Toad",
    "Boo",
    "Toadette",
    "Red Shy Guy",
    "Birdo",
    "Monty Mole",
    "Bowser Jr.",
    "Red Koopa Paratroopa",
    "Blue Pianta",
    "Red Pianta",
    "Yellow Pianta",
    "Blue Noki",
    "Red Noki",
    "Green Noki",
    "Hammer Bro",
    "Toadsworth",
    "Blue Toad",
    "Yellow Toad",
    "Green Toad",
    "Purple Toad",
    "Blue Magikoopa",
    "Red Magikoopa",
    "Green Magikoopa",
    "Yellow Magikoopa",
    "King Boo",
    "Petey Piranha",
    "Dixie Kong",
    "Goomba",
    "Paragoomba",
    "Red Koopa Troopa",
    "Green Koopa Paratroopa",
    "Blue Shy Guy",
    "Yellow Shy Guy",
    "Green Shy Guy",
    "Gray Shy Guy",
    "Gray Dry Bones",
    "Green Dry Bones",
    "Dark Bones",
    "Blue Dry Bones",
    "Fire Bro",
    "Boomerang Bro",
    "Wiggler",
    "Blooper",
    "Funky Kong",
    "Tiny Kong",
    "Green Kritter",
    "Blue Kritter",
    "Red Kritter",
    "Brown Kritter",
    "King K. Rool",
    "Baby Peach",
    "Baby Daisy",
    "Baby DK",
    "Red Yoshi",
    "Blue Yoshi",
    "Yellow Yoshi",
    "Light Blue Yoshi",
    "Pink Yoshi",
    "Unused Yoshi 2",
    "Unused Yoshi",
    "Unused Toad",
    "Unused Pianta",
    "Unused Kritter",
    "Unused Koopa",
]

for mii in mii_list:
    charList.append(mii.name)

captains = [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 17, 19]

speed_const = 0.03


"""with open("teams.json", mode="w", encoding="utf-8") as write_file:
    json.dump({
        "teams": teams,
        "team_names": team_names
    }, write_file)"""


positions = ["P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]

stadiums = [
    "Mario Stadium",
    "Bowser Castle",
    "Wario City",
    "Yoshi Park",
    "Peach Ice Garden",
    "DK Jungle",
    "Luigi's Mansion",
    "Daisy Cruiser",
    "Bowser Jr. Playroom",
]


class Formationizer:
    def __init__(self, team1, team2, stadium, rules):
        self.team1 = team1
        self.team2 = team2
        self.stadium = stadium
        self.rules = rules
        self.autoStart = options.get("AutoStart", True)

    def automate(self):
        print("Starting")
        fl = gw.getAllWindows()
        for f in fl:
            if "Dolphin" in f.title and " | " in f.title:
                f.activate()
        time.sleep(0.2)
        self.execute("awawawwwaawwwwwwwwrrawwwwd")
        self.finalize()
        self.generate_whodeyy_code()
        self.sel_code_rev()
        self.press_a()

        self.execute("wwulur")
        self.lineup_code_rev(self.team1)
        self.execute("druldr")
        self.lineup_code_rev(self.team2)
        self.execute("uruaw")

        time.sleep(0.25)
        self.finalize()
        time.sleep(0.25)
        if self.autoStart:
            self.startGame()

    def sel_code_rev(self):
        t1miis = []
        t2miis = []
        for i in range(9):
            if self.team1[i][0] > 76:
                t1miis.append([self.team1[i][0] - 77, self.team1[i][1]])
            if self.team2[i][0] > 76:
                t2miis.append([self.team2[i][0] - 77, self.team2[i][1]])
        self.handleMiis(t1miis, 0)
        self.handleMiis(t2miis, 1)

    def handleMiis(self, arr, dir, total_miis=None):
        # Prefer explicit total_miis, otherwise try to use a value stored on the class
        if total_miis is None:
            total_miis = getattr(self, "total_miis", None) or getattr(
                self, "mii_count", None
            )

        # If we STILL don't know, we can’t reliably detect the "overall last page"
        if total_miis is None:
            raise ValueError(
                "handleMiis needs total_miis (or set self.total_miis / self.mii_count) "
                "to correctly handle the last page for arbitrary Mii counts."
            )

        last_page = (total_miis - 1) // 10  # 0-based last page index

        if len(arr) > 0:
            for i in range(len(arr)):
                self.execute("awllllll")
                idx = arr[i][0]
                v = idx

                target_page = idx // 10  # 0-based page we need
                turns = 0

                while v >= 10:
                    v -= 10
                    turns += 1
                    self.execute("rrrrralllll")

                # ✅ Apply your special anchor ONLY if the target Mii is on the overall last page
                # This prevents it from firing on "first pass" for normal pages.
                if target_page == last_page and turns == target_page:
                    self.press_left()
                    self.press_left()
                    self.press_left()
                    self.press_up()

                for n in range(v % 5):
                    self.press_right()
                if v >= 5:
                    self.press_down()

                self.press_a()
                self.press_b()
                time.sleep(0.5)

        if dir == 0:
            self.execute("uuadd")
        else:
            self.execute("dauu")

    def lineup_code_rev(self, team):
        mlist = []
        for pl in team:
            if pl[0] > 76:
                mlist.append(pl)
        pos = 0
        i = 0
        while i < len(mlist):
            targ = i + 1
            while pos < targ:
                self.press_right()
                pos += 1
            while pos > targ:
                self.press_left()
                pos -= 1
            self.press_a()
            targ = mlist[i][1]
            while pos < targ:
                self.press_right()
                pos += 1
            while pos > targ:
                self.press_left()
                pos -= 1
            self.press_a()
            if targ > i + 1 and targ <= len(mlist):
                temp = mlist[i]
                mlist[i] = mlist[targ - 1]
                mlist[targ - 1] = temp
            else:
                i += 1
        targ = 8
        while pos < targ:
            self.press_right()
            pos += 1
        while pos > targ:
            self.press_left()
            pos -= 1

    def generate_whodeyy_code(self):
        DMM.hook()
        DMM.write_word(0x8006AED4, 0x4BF97324)
        currLine = 0x800021F0
        countline = 0

        DMM.write_word(currLine, 0xC206AED4)
        currLine += 4
        DMM.write_word(currLine, 0x00000000)
        currLine += 4
        DMM.write_word(currLine, 0x2C0E0001)
        currLine += 4
        countline += 1
        DMM.write_word(currLine, 0x4182009C)
        currLine += 4
        countline += 1
        mii1list = []
        mii2list = []
        for i in range(9):
            if self.team1[i][0] > 76:
                mii1list.append(self.team1[i])
            if self.team2[i][0] > 76:
                mii2list.append(self.team2[i])
        print(len(mii1list), ": ", mii1list)
        print("Team 1:")
        miipos = 1
        for i in range(9):
            if (
                self.team1[i][0] > 76
            ):  ##If character is mii, ignore setting batting order and just set fielding
                print(
                    "\tMii found: ID = na, BP = ", miipos, ", FP = ", self.team1[i][2]
                )
                DMM.write_word(currLine, 0x60000000)
                currLine += 4
                countline += 1
                DMM.write_word(currLine, 0x60000000)
                currLine += 4
                countline += 1
                DMM.write_word(currLine, 0x39E00000 + int(self.team1[i][2]))
                currLine += 4
                countline += 1
                DMM.write_word(currLine, 0x99E3000C + int(miipos * 0x10))
                currLine += 4
                countline += 1
                miipos += 1
            else:
                print(
                    "\tChar found: ID = ",
                    self.team1[i][0],
                    ", BP = ",
                    self.team1[i][1],
                    ", FP = ",
                    self.team1[i][2],
                )
                pos = self.team1[i][1]
                while (
                    pos > 0 and pos <= len(mii1list)
                ):  ##Im literally on my hands and knees praying this works the way I want it to
                    print(
                        "\t\tWould, overwrite mii, setting BP = ", mii1list[pos - 1][1]
                    )
                    pos = mii1list[pos - 1][1]
                DMM.write_word(currLine, 0x39E00000 + int(self.team1[i][0]))
                currLine += 4
                countline += 1
                DMM.write_word(currLine, 0x99E30001 + int(pos * 0x10))
                currLine += 4
                countline += 1
                DMM.write_word(currLine, 0x39E00000 + int(self.team1[i][2]))
                currLine += 4
                countline += 1
                DMM.write_word(currLine, 0x99E3000C + int(pos * 0x10))
                currLine += 4
                countline += 1
        DMM.write_word(currLine, 0x39C00001)
        currLine += 4
        countline += 1
        DMM.write_word(currLine, 0x48000098)
        currLine += 4
        countline += 1
        print("Team 2:")
        miipos = 1
        for i in range(9):
            if (
                self.team2[i][0] > 76
            ):  ##If character is mii, ignore setting batting order and just set fielding
                print(
                    "\tMii found: ID = na, BP = ", miipos, ", FP = ", self.team2[i][2]
                )
                DMM.write_word(currLine, 0x60000000)
                currLine += 4
                countline += 1
                DMM.write_word(currLine, 0x60000000)
                currLine += 4
                countline += 1
                DMM.write_word(currLine, 0x39E00000 + int(self.team2[i][2]))
                currLine += 4
                countline += 1
                DMM.write_word(currLine, 0x99E3000C + int(miipos * 0x10))
                currLine += 4
                countline += 1
                miipos += 1
            else:
                print(
                    "\tChar found: ID = ",
                    self.team1[i][0],
                    ", BP = ",
                    self.team1[i][1],
                    ", FP = ",
                    self.team1[i][2],
                )
                pos = self.team2[i][1]
                while (
                    pos > 0 and pos <= len(mii2list)
                ):  ##Im literally on my hands and knees praying this works the way I want it to
                    print(
                        "\t\tWould, overwrite mii, setting BP = ", mii2list[pos - 1][1]
                    )
                    pos = mii2list[pos - 1][1]
                DMM.write_word(currLine, 0x39E00000 + int(self.team2[i][0]))
                currLine += 4
                countline += 1
                DMM.write_word(currLine, 0x99E30001 + int(pos * 0x10))
                currLine += 4
                countline += 1
                DMM.write_word(currLine, 0x39E00000 + int(self.team2[i][2]))
                currLine += 4
                countline += 1
                DMM.write_word(currLine, 0x99E3000C + int(pos * 0x10))
                currLine += 4
                countline += 1
        DMM.write_word(currLine, 0x39C00000)
        currLine += 4
        countline += 1
        while countline % 4 != 3:
            DMM.write_word(currLine, 0x60000000)
            currLine += 4
            countline += 1

        DMM.write_word(currLine, 0x8006AED8 - currLine + 0x48000000)
        currLine += 4
        countline += 1
        DMM.write_word(0x800021F4, 0x00000000 + int(countline / 2))
        DMM.un_hook()

    def formation_code_rev(self):
        DMM.hook()
        reg3 = DMM.read_word(0x806D121E)
        print(hex(reg3))

        DMM.write_byte(0x811F769D, self.stadium[0])
        DMM.write_byte(0x811F769E, self.stadium[1])
        DMM.write_byte(0x811F769F, self.stadium[1])

        DMM.write_byte(0x811F76AC, self.team1[0][0])
        DMM.write_byte(0x811F76AD, self.team2[0][0])

        for i in range(9):
            pl = self.team1[i]
            if pl[0] < 71:
                DMM.write_byte(reg3 + (pl[1] * 0x10 + 0x01) - 0x90, pl[0])
            DMM.write_byte(reg3 + (pl[1] * 0x10 + 0x0C) - 0x90, pl[2])
            pl = self.team2[i]
            if pl[0] < 71:
                DMM.write_byte(reg3 + (pl[1] * 0x10 + 0x01), pl[0])
            DMM.write_byte(reg3 + (pl[1] * 0x10 + 0x0C), pl[2])

        DMM.un_hook()
        time.sleep(1)

    def finalize(self):
        DMM.hook()
        DMM.write_byte(0x811F769D, self.stadium[0])
        DMM.write_byte(0x811F769E, self.stadium[1])
        DMM.write_byte(0x811F769F, self.stadium[1])
        c1 = -1
        c2 = -1
        if self.team1[0][0] in captains:
            c1 = captains.index(self.team1[0][0])
        if self.team2[0][0] in captains:
            c2 = captains.index(self.team2[0][0])
        if c1 == -1:
            default_away_id = int(options.get("DefaultAwayCaptainID", captains[0]))
            c1 = captains.index(default_away_id) if default_away_id in captains else 0
        if c2 == -1:
            default_home_id = int(
                options.get(
                    "DefaultHomeCaptainID",
                    captains[1] if len(captains) > 1 else captains[0],
                )
            )
            c2 = (
                captains.index(default_home_id)
                if default_home_id in captains
                else (1 if len(captains) > 1 else 0)
            )
        DMM.write_byte(0x811F76AC, c1)
        DMM.write_byte(0x811F76AD, c2)

        DMM.write_byte(0x80794328, self.rules[0])
        DMM.write_byte(0x80794329, self.rules[1])
        DMM.write_byte(0x8079432A, self.rules[2])
        DMM.write_byte(0x8079432B, self.rules[3])

    def find_in(list, val):
        for i in range(len(list)):
            if list[i] == val:
                return i
        return -1

    def find_in_2D(list, val):
        for r in range(len(list)):
            for c in range(len(list[r])):
                if list[r][c] == val:
                    return [r, c]
        return -1

    def press_a(self):
        kb.press("k")
        time.sleep(INPUT_DELAY)
        kb.release("k")
        time.sleep(RELEASE_DELAY)

    def press_b(self):
        kb.press("l")
        time.sleep(INPUT_DELAY)
        kb.release("l")
        time.sleep(RELEASE_DELAY)

    def press_left(self):
        kb.press("a")
        time.sleep(INPUT_DELAY)
        kb.release("a")
        time.sleep(RELEASE_DELAY)

    def press_right(self):
        kb.press("d")
        time.sleep(INPUT_DELAY)
        kb.release("d")
        time.sleep(RELEASE_DELAY)

    def press_up(self):
        kb.press("w")
        time.sleep(INPUT_DELAY)
        kb.release("w")
        time.sleep(RELEASE_DELAY)

    def press_down(self):
        kb.press("s")
        time.sleep(INPUT_DELAY)
        kb.release("s")
        time.sleep(RELEASE_DELAY)

    def press_plus(self):
        kb.press("e")
        time.sleep(INPUT_DELAY)
        kb.release("e")
        time.sleep(RELEASE_DELAY)

    def startGame(self):
        kb.press("q")
        time.sleep(INPUT_DELAY)
        kb.press("k")
        time.sleep(INPUT_DELAY)
        kb.release("k")
        time.sleep(RELEASE_DELAY)
        kb.release("q")
        time.sleep(RELEASE_DELAY)

    def execute(self, instructions):
        for i in instructions:
            if i == "u":
                self.press_up()
            elif i == "d":
                self.press_down()
            elif i == "l":
                self.press_left()
            elif i == "r":
                self.press_right()
            elif i == "a":
                self.press_a()
            elif i == "w":
                time.sleep(0.5)

        time.sleep(INPUT_DELAY)  # <-- important

    def setAway(self, team):
        self.team1 = team
        # print(self.team1)

    def setHome(self, team):
        self.team2 = team
        # print(self.team1)

    def setStadium(self, val):
        self.stadium[0] = stadiums.index(val)
        # print(self.stadium)

    def setDay(self, val):
        self.stadium[1] = val
        # print(self.stadium)

    def setRule(self, loc, val):
        self.rules[loc] = val
        # print(self.rules)


myFormationizer = Formationizer(
    [
        [0, 0, 0],
        [0, 1, 1],
        [0, 2, 2],
        [0, 3, 3],
        [0, 4, 4],
        [0, 5, 5],
        [0, 6, 6],
        [0, 7, 7],
        [0, 8, 8],
    ],
    [
        [1, 0, 0],
        [1, 1, 1],
        [1, 2, 2],
        [1, 3, 3],
        [1, 4, 4],
        [1, 5, 5],
        [1, 6, 6],
        [1, 7, 7],
        [1, 8, 8],
    ],
    [0x0, 0],
    [9, 1, 1, 0],
)
myFormationizer.total_miis = len(mii_list)
print("[INFO] total_miis =", myFormationizer.total_miis)


class mssApp:
    def __init__(self):
        self.master = tk.Tk()
        # self.master.geometry("700x500")
        self.master.resizable(False, False)
        self.master.wm_title("Make My Team MSS")

        self.toBat = []
        self.toField = []
        self.validTeam = False

        self.entries = [None] * 9
        self.battings = [None] * 9
        self.fieldings = [None] * 9

        nb = ttk.Notebook(self.master)

        tabMain = tk.Frame(nb, height=1400, width=700)
        tabMain.pack(padx=30, pady=30)

        lpaneTeam = tk.LabelFrame(tabMain, text="Teams")
        lpaneTeam.grid(row=0, column=0, padx=30)
        labelAway = tk.Label(lpaneTeam, text="Away:")
        labelAway.grid(row=0, column=0)
        comboxAway = ttk.Combobox(lpaneTeam, values=team_names, state="readonly")
        comboxAway.grid(row=1, column=0)
        comboxAway.bind(
            "<<ComboboxSelected>>",
            lambda event: myFormationizer.setAway(
                teams[team_names.index(comboxAway.get())]
            ),
        )
        comboxAway.bind(
            "<<ComboboxSelected>>",
            lambda event: textboxAway.configure(text=getText(myFormationizer.team1)),
            add="+",
        )
        textboxAway = tk.Label(
            lpaneTeam, height=10, width=25, text=getText(myFormationizer.team1)
        )
        textboxAway.bind("<Key>", lambda e: "break")
        textboxAway.grid(row=2, column=0)
        labelHome = tk.Label(lpaneTeam, text="Home:")
        labelHome.grid(row=0, column=1)
        comboxHome = ttk.Combobox(lpaneTeam, values=team_names, state="readonly")
        comboxHome.grid(row=1, column=1)
        comboxHome.bind(
            "<<ComboboxSelected>>",
            lambda event: myFormationizer.setHome(
                teams[team_names.index(comboxHome.get())]
            ),
        )
        comboxHome.bind(
            "<<ComboboxSelected>>",
            lambda event: textboxHome.configure(text=getText(myFormationizer.team2)),
            add="+",
        )
        textboxHome = tk.Label(
            lpaneTeam, height=10, width=25, text=getText(myFormationizer.team2)
        )
        textboxHome.bind("<Key>", lambda e: "break")
        textboxHome.grid(row=2, column=1)

        lpaneStadium = tk.LabelFrame(tabMain, text="Stadium")
        lpaneStadium.grid(row=1, column=0)
        comboxStadium = ttk.Combobox(lpaneStadium, values=stadiums, state="readonly")
        comboxStadium.set("Mario Stadium")
        comboxStadium.grid(row=0, column=0, rowspan=2)
        comboxStadium.bind(
            "<<ComboboxSelected>>",
            lambda event: myFormationizer.setStadium(comboxStadium.get()),
        )
        num = tk.IntVar()
        radioDay = tk.Radiobutton(
            lpaneStadium,
            text="Day",
            variable=num,
            value=1,
            command=lambda: myFormationizer.setDay(0),
        )
        radioDay.grid(row=0, column=1)
        radioNight = tk.Radiobutton(
            lpaneStadium,
            text="Night",
            variable=num,
            value=2,
            command=lambda: myFormationizer.setDay(1),
        )
        radioNight.grid(row=1, column=1)
        num.set(1)

        lpaneRules = tk.LabelFrame(tabMain, text="Rules")
        lpaneRules.grid(row=2, column=0)
        labelInnings = tk.Label(lpaneRules, text="Innings:")
        labelInnings.grid(row=0, column=0)
        comboxInnings = ttk.Combobox(
            lpaneRules, values=[1, 3, 5, 7, 9], state="readonly"
        )
        comboxInnings.set(9)
        comboxInnings.bind(
            "<<ComboboxSelected>>",
            lambda event: myFormationizer.setRule(0, int(comboxInnings.get())),
        )
        comboxInnings.grid(row=0, column=1)
        labelMercy = tk.Label(lpaneRules, text="Mercy:")
        labelMercy.grid(row=0, column=2)
        comboxMercy = ttk.Combobox(lpaneRules, values=["Off", "On"], state="readonly")
        comboxMercy.set("On")
        comboxMercy.bind(
            "<<ComboboxSelected>>",
            lambda event: myFormationizer.setRule(
                1, int(["Off", "On"].index(comboxMercy.get()))
            ),
        )
        comboxMercy.grid(row=0, column=3)
        labelStars = tk.Label(lpaneRules, text="Stars:")
        labelStars.grid(row=1, column=0)
        comboxStars = ttk.Combobox(lpaneRules, values=["Off", "On"], state="readonly")
        comboxStars.set("On")
        comboxStars.bind(
            "<<ComboboxSelected>>",
            lambda event: myFormationizer.setRule(
                2, int(["Off", "On"].index(comboxStars.get()))
            ),
        )
        comboxStars.grid(row=1, column=1)
        labelItems = tk.Label(lpaneRules, text="Items:")
        labelItems.grid(row=1, column=2)
        comboxItems = ttk.Combobox(lpaneRules, values=["Off", "On"], state="readonly")
        comboxItems.set("Off")
        comboxItems.bind(
            "<<ComboboxSelected>>",
            lambda event: myFormationizer.setRule(
                3, int(["Off", "On"].index(comboxItems.get()))
            ),
        )
        comboxItems.grid(row=1, column=3)

        autoStartVar = tk.BooleanVar(value=options.get("AutoStart", True))

        def onAutoStartToggle():
            myFormationizer.autoStart = autoStartVar.get()
            options["AutoStart"] = autoStartVar.get()
            with open("options.json", "w") as f:
                json.dump(options, f, indent=4)

        checkAutoStart = tk.Checkbutton(
            tabMain,
            text="Auto-start game",
            variable=autoStartVar,
            command=onAutoStartToggle,
        )
        checkAutoStart.grid(row=3, column=0, sticky="w")

        buttonStart = tk.Button(
            tabMain, text="Run it!", command=myFormationizer.automate
        )
        buttonStart.grid(row=4, column=0)
        labelWarning = tk.Label(
            tabMain,
            text="Before using, make sure you have the following Gecko code enabled: \n040802b4 60000000\n040802b8 60000000\n0406aed8 48000b80\n"
            + "And set these to the controls:\nWSAD = Up/Down/Left/Right\nK = A button\nL = B button\nQ = - button\nE = + button\n"
            + 'Hit the Run button while the game is open and you are \nat the main menu, hovering "Exhibition Mode"\nProgrammed by STG, with help from Whodeyy, Kircher, & Harrhy \nand the rest of the MSS community',
        )
        labelWarning.grid(row=1, column=1, rowspan=5)

        tabTeams = tk.Frame(nb, height=1400, width=700)
        tabTeams.pack(padx=30, pady=30)
        currName = tk.StringVar()
        lpaneManage = tk.LabelFrame(tabTeams, text="Manage")
        lpaneManage.grid(row=0, column=0, columnspan=2)
        comboxTeams = ttk.Combobox(lpaneManage, values=team_names, state="readonly")
        comboxTeams.set("")
        comboxTeams.grid(row=0, column=0)
        buttonLoad = tk.Button(lpaneManage, text="Load")
        buttonLoad.bind(
            "<ButtonPress-1>",
            lambda event: self.loadTeam(
                self.entries,
                self.battings,
                self.fieldings,
                team_names.index(comboxTeams.get()),
            ),
            add="+",
        )
        buttonLoad.bind(
            "<ButtonPress-1>", lambda event: currName.set(comboxTeams.get()), add="+"
        )
        buttonLoad.grid(row=0, column=1)
        buttonRemove = tk.Button(lpaneManage, text="Delete")
        buttonRemove.bind(
            "<ButtonPress-1>", lambda event: self.deleteTeam(comboxTeams), add="+"
        )
        buttonRemove.bind(
            "<ButtonPress-1>",
            lambda event: self.updateTeams(comboxAway, comboxHome, comboxTeams),
            add="+",
        )
        buttonRemove.grid(row=0, column=2)
        entryName = tk.Entry(lpaneManage, textvariable=currName)
        entryName.grid(row=0, column=3)
        buttonSave = tk.Button(lpaneManage, text="Save")
        buttonSave.bind(
            "<ButtonPress-1>",
            lambda event: self.saveTeam(
                currName.get(), self.entries, self.battings, self.fieldings
            ),
            add="+",
        )
        buttonSave.bind(
            "<ButtonPress-1>",
            lambda event: self.updateTeams(comboxAway, comboxHome, comboxTeams),
            add="+",
        )
        buttonSave.grid(row=0, column=4)

        lpaneSelect = tk.LabelFrame(tabTeams, text="Select")
        lpaneSelect.grid(row=1, column=0, rowspan=2)
        lpaneBatting = tk.LabelFrame(tabTeams, text="Batting")
        lpaneBatting.grid(row=1, column=1)
        lpaneFielding = tk.LabelFrame(tabTeams, text="Fielding")
        lpaneFielding.grid(row=2, column=1)

        fsu = [[2, 2], [3, 2], [2, 4], [1, 3], [2, 0], [1, 1], [0, 0], [0, 2], [0, 4]]

        for i in range(9):
            if i == 0:
                lpaneCaptain = tk.LabelFrame(lpaneSelect, text="Captain")
                lpaneCaptain.grid(row=0, column=0, pady=5)
                self.entries[i] = ttk.Combobox(lpaneCaptain, values=sorted(charList))
                self.entries[i].pack()
                self.entries[i].bind(
                    "<<ComboboxSelected>>",
                    lambda event: self.updateLists(
                        self.entries, self.battings, self.fieldings
                    ),
                )
            else:
                self.entries[i] = ttk.Combobox(lpaneSelect, values=sorted(charList))
                self.entries[i].grid(row=i, column=0)
                self.entries[i].bind(
                    "<<ComboboxSelected>>",
                    lambda event: self.updateLists(
                        self.entries, self.battings, self.fieldings
                    ),
                )

            # Batting dropdowns (unchanged)
            self.battings[i] = ttk.Combobox(lpaneBatting, values=self.toBat)
            self.battings[i].grid(row=0, column=i)
            self.battings[i].bind(
                "<<ComboboxSelected>>",
                lambda event: self.updateLists(
                    self.entries, self.battings, self.fieldings
                ),
            )

            # ---- NEW: Fielding label + dropdown ----
            row = fsu[i][0]
            col = fsu[i][1] * 2  # spread out columns so label + box fit

            # Label showing position (P, C, 1B, etc.)
            tk.Label(lpaneFielding, text=positions[i]).grid(
                row=row, column=col, padx=(0, 4), sticky="e"
            )

            # Fielding dropdown
            self.fieldings[i] = ttk.Combobox(lpaneFielding)
            self.fieldings[i].grid(row=row, column=col + 1)
            self.fieldings[i].bind(
                "<<ComboboxSelected>>",
                lambda event: self.updateLists(
                    self.entries, self.battings, self.fieldings
                ),
            )

        tabOptions = tk.Frame(nb, height=1400, width=700)
        tabOptions.pack(padx=30, pady=30)
        lpaneMiis = tk.LabelFrame(tabOptions, text="Miis")
        lpaneMiis.grid(row=0, column=0)
        labelMiis = tk.Label(
            lpaneMiis,
            text="Please enter the path to your RFL_DB.dat\nMore info: https://jackharrhy.github.io/mii-lib/",
        )
        labelMiis.grid(row=0, column=0)
        varPath = tk.StringVar()
        varPath.set(options["MiiDBPath"])
        entryPath = tk.Entry(
            lpaneMiis,
            textvariable=varPath,
        )
        entryPath.grid(row=1, column=0)
        buttonMiiSave = tk.Button(lpaneMiis, text="Save")
        buttonMiiSave.grid(row=1, column=1)
        buttonMiiSave.bind(
            "<ButtonPress-1>", lambda event: self.updateChars(varPath.get())
        )

        # Default captains to use when a selected player isn't one of the 12 captains
        lpaneDefaults = tk.LabelFrame(tabOptions, text="Default Captains")
        lpaneDefaults.grid(row=1, column=0, pady=10, sticky="w")

        captainNameValues = [charList[i] for i in captains]

        tk.Label(lpaneDefaults, text="Away default:").grid(row=0, column=0, sticky="w")
        varAwayDefault = tk.StringVar()
        away_default_id = int(options.get("DefaultAwayCaptainID", captains[0]))
        away_idx = captains.index(away_default_id) if away_default_id in captains else 0
        varAwayDefault.set(captainNameValues[away_idx])
        comboAwayDefault = ttk.Combobox(
            lpaneDefaults,
            textvariable=varAwayDefault,
            values=captainNameValues,
            state="readonly",
        )
        comboAwayDefault.grid(row=0, column=1, padx=5, pady=2)

        tk.Label(lpaneDefaults, text="Home default:").grid(row=1, column=0, sticky="w")
        varHomeDefault = tk.StringVar()
        home_default_id = int(
            options.get(
                "DefaultHomeCaptainID",
                captains[1] if len(captains) > 1 else captains[0],
            )
        )
        home_idx = (
            captains.index(home_default_id)
            if home_default_id in captains
            else (1 if len(captains) > 1 else 0)
        )
        varHomeDefault.set(captainNameValues[home_idx])
        comboHomeDefault = ttk.Combobox(
            lpaneDefaults,
            textvariable=varHomeDefault,
            values=captainNameValues,
            state="readonly",
        )
        comboHomeDefault.grid(row=1, column=1, padx=5, pady=2)

        buttonDefaultsSave = tk.Button(lpaneDefaults, text="Save Defaults")
        buttonDefaultsSave.grid(row=2, column=1, sticky="e", pady=(6, 0))
        buttonDefaultsSave.bind(
            "<ButtonPress-1>",
            lambda event: self.updateDefaultCaptains(
                varAwayDefault.get(), varHomeDefault.get(), captainNameValues
            ),
        )

        nb.add(tabMain, text="Main")
        nb.add(tabTeams, text="Team Manager")
        nb.add(tabOptions, text="Options")
        nb.pack(expand=1, fill="both")
        self.master.mainloop()

    def saveTeam(self, name, ent, bat, fld):
        # print(ent)
        if not self.validTeam:
            showerror("Team Save Error", self.errorMessage)
        else:
            team = []
            en = []
            ba = []
            fl = []
            for i in range(9):
                # print(ent[i].get())
                en.append(ent[i].get())
                ba.append(bat[i].get())
                fl.append(fld[i].get())

            for i in range(9):
                c = en[i]
                v = [charList.index(c), ba.index(c), fl.index(c)]
                team.append(v)
                ba[ba.index(c)] = ""
                fl[fl.index(c)] = ""

            if name in team_names:
                ans = askyesno(
                    "Overwrite Team Confirmation",
                    "This will overwrite team: \n" + name + "\nAre you sure?",
                )
                if ans:
                    tid = team_names.index(name)
                    teams[tid] = team
            else:
                team_names.append(name)
                teams.append(team)
                showinfo(
                    "Team added successfully", 'Team "' + name + '" added to register'
                )

        print(team_names)
        print(teams)

    def deleteTeam(self, sel):
        team = sel.get()
        ans = askyesno(
            "Delete Team Confirmation",
            "Are you sure you want to delete team: \n" + team,
        )
        if ans:
            tid = team_names.index(team)
            teams.pop(tid)
            team_names.pop(tid)
            sel.configure(values=team_names)

        print(team_names)
        print(teams)

    def updateChars(self, p):
        global mii_list, charList, myFormationizer

        options["MiiDBPath"] = p
        mii_list = []
        try:
            db = MiiDatabase(Path(options["MiiDBPath"]), MiiType.WII_PLAZA)

            for mii in db:
                v = int(str_to_hex(mii.mii_id.hex()))
                if v >= 0x80000000 and v < 0x90000000:
                    mii_list.append(mii)
                    print(mii.name)
        except:
            print("File error")

        # ✅ update Formationizer's total_miis whenever DB changes
        myFormationizer.total_miis = len(mii_list)
        print("[INFO] total_miis updated =", myFormationizer.total_miis)

        with open("options.json", mode="w", encoding="utf-8") as write_file:
            json.dump(options, write_file)

        charList = [
            "Mario",
            "Luigi",
            "Donkey Kong",
            "Diddy Kong",
            "Peach",
            "Daisy",
            "Green Yoshi",
            "Baby Mario",
            "Baby Luigi",
            "Bowser",
            "Wario",
            "Waluigi",
            "Green Koopa Troopa",
            "Red Toad",
            "Boo",
            "Toadette",
            "Red Shy Guy",
            "Birdo",
            "Monty Mole",
            "Bowser Jr.",
            "Red Koopa Paratroopa",
            "Blue Pianta",
            "Red Pianta",
            "Yellow Pianta",
            "Blue Noki",
            "Red Noki",
            "Green Noki",
            "Hammer Bro",
            "Toadsworth",
            "Blue Toad",
            "Yellow Toad",
            "Green Toad",
            "Purple Toad",
            "Blue Magikoopa",
            "Red Magikoopa",
            "Green Magikoopa",
            "Yellow Magikoopa",
            "King Boo",
            "Petey Piranha",
            "Dixie Kong",
            "Goomba",
            "Paragoomba",
            "Red Koopa Troopa",
            "Green Koopa Paratroopa",
            "Blue Shy Guy",
            "Yellow Shy Guy",
            "Green Shy Guy",
            "Gray Shy Guy",
            "Gray Dry Bones",
            "Green Dry Bones",
            "Dark Bones",
            "Blue Dry Bones",
            "Fire Bro",
            "Boomerang Bro",
            "Wiggler",
            "Blooper",
            "Funky Kong",
            "Tiny Kong",
            "Green Kritter",
            "Blue Kritter",
            "Red Kritter",
            "Brown Kritter",
            "King K. Rool",
            "Baby Peach",
            "Baby Daisy",
            "Baby DK",
            "Red Yoshi",
            "Blue Yoshi",
            "Yellow Yoshi",
            "Light Blue Yoshi",
            "Pink Yoshi",
            "Unused Yoshi 2",
            "Unused Yoshi",
            "Unused Toad",
            "Unused Pianta",
            "Unused Kritter",
            "Unused Koopa",
        ]

        for mii in mii_list:
            charList.append(mii.name)

        for e in self.entries:
            e.configure(values=sorted(charList))

    def updateDefaultCaptains(self, away_name, home_name, captainNameValues):
        """Persist default captain selections to options.json as character IDs."""
        try:
            away_idx = captainNameValues.index(away_name)
            home_idx = captainNameValues.index(home_name)
        except ValueError:
            showerror("Error", "Could not save defaults: invalid captain selection.")
            return

        options["DefaultAwayCaptainID"] = captains[away_idx]
        options["DefaultHomeCaptainID"] = captains[home_idx]

        try:
            with open("options.json", "w") as outfile:
                json.dump(options, outfile, indent=4)
            showinfo("Saved", "Default captains saved!")
        except Exception as e:
            showerror("Error", f"Failed to write options.json: {e}")

    def updateTeams(self, ca, ch, ct):
        ca.configure(values=team_names)
        ch.configure(values=team_names)
        ct.configure(values=team_names)
        with open("teams.json", mode="w", encoding="utf-8") as write_file:
            json.dump({"teams": teams, "team_names": team_names}, write_file)

    def updateLists(self, en, ba, fl):
        self.toBat = [""]
        self.toField = [""]
        self.validTeam = True
        self.errorMessage = ""
        for e in en:
            v = e.get()

            if v != "":
                self.toBat.append(e.get())
                self.toField.append(e.get())
            else:
                self.validTeam = False
                if self.errorMessage == "":
                    self.errorMessage = "Missing Entry"

        for b in ba:
            v = b.get()
            if v != "" and v in self.toBat:
                self.toBat.pop(self.toBat.index(v))
            elif v == "":
                self.validTeam = False
                if self.errorMessage == "":
                    self.errorMessage = "Missing Batting order"
            else:
                self.validTeam = False
                self.errorMessage = "Invalid Batting order"

        for b in fl:
            v = b.get()
            if v != "" and v in self.toField:
                self.toField.pop(self.toField.index(v))
            elif v == "":
                self.validTeam = False
                if self.errorMessage == "":
                    self.errorMessage = "Missing Fielding position"
            else:
                self.validTeam = False
                self.errorMessage = "Invalid Fielding position"
        for b in ba:
            b.configure(values=self.toBat)
        for f in fl:
            f.configure(values=self.toField)

    def loadTeam(self, en, ba, fl, num):
        tm = teams[num].copy()
        for i in range(9):
            c = ""
            try:
                c = charList[tm[i][0]]
            except:
                print("Invalid Mii Detected")
            en[i].set(c)
            set_entry(ba[tm[i][1]], c)
            set_entry(fl[tm[i][2]], c)
        self.updateLists(self.entries, self.battings, self.fieldings)
        return


def set_entry(en, text):
    en.delete(0, tk.END)
    en.insert(0, text)


def getText(team):
    ans = ""
    teamS = sorted(team, key=lambda c: c[1])
    for char in teamS:
        ans += charList[char[0]]
        ans += " - "
        ans += positions[char[2]]
        ans += "\n"
    return ans


appInst = mssApp()
