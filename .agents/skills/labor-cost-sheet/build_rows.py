#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""로우데이터 탭 → 「인건비 정산 요청 시트」 A~U 행 변환기.

표준 라이브러리만 사용한다 (openpyxl 불필요). xlsx 를 zip+xml 로 직접 읽는다.

usage:
  python build_rows.py --month 2026-07 --pm 송찬호
  python build_rows.py --month 2026-07 --pm 송찬호 --axhub axhub.json
"""
import argparse
import datetime as dt
import io
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_XLSX = os.path.join(
    HERE, "[AX교육팀] 개인 강의료 정산 및 증빙 서류 제출 양식.xlsx"
)

# 요청시트 고정값
TEAM = "AX교육팀"
PRODUCT = "B2B"
WORKTYPE = {
    "기술튜터": "튜터-관리,실시간",
    "주강사": "튜터-강의사용/제작료",
}
KOR_AMOUNT_THRESHOLD = 5_000_000

# qualification_catalog.code 접두어 → 역할. 로우데이터 E열(강사/기술튜터) 표기와 같은 어휘를 쓴다.
QUAL_ROLE = {
    "main": "주강사",
    "tutor": "기술튜터",
    "mentor": "멘토",
    "special": "특강",
}


def qual_role(code):
    """'tutor_l2' → '기술튜터'. 모르는 코드는 원문을 그대로 돌려준다(추측하지 않는다)."""
    return QUAL_ROLE.get((code or "").split("_")[0], code or "")

# ---------------------------------------------------------------- xlsx 읽기

_ENT = {"&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#10;": "\n"}


def _unescape(s):
    for k, v in _ENT.items():
        s = s.replace(k, v)
    return s.replace("&amp;", "&")  # 마지막에 처리해야 이중 디코딩이 안 난다


def load_sheets(path):
    """{시트명: {행번호: {열문자: 값문자열}}} 반환."""
    z = zipfile.ZipFile(path)
    shared = [
        _unescape("".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)))
        for si in re.findall(r"<si>(.*?)</si>", z.read("xl/sharedStrings.xml").decode("utf8"), re.S)
    ]
    names = re.findall(r'name="([^"]+)"[^>]*r:id="rId(\d+)"', z.read("xl/workbook.xml").decode("utf8"))
    out = {}
    for idx, (name, _rid) in enumerate(names, 1):
        xml = z.read("xl/worksheets/sheet%d.xml" % idx).decode("utf8")
        rows = {}
        for rm in re.finditer(r'<row[^>]*\br="(\d+)"[^>]*>(.*?)</row>', xml, re.S):
            cells = {}
            for cm in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', rm.group(2), re.S):
                col, attrs, inner = cm.group(1), cm.group(2), cm.group(3) or ""
                vm = re.search(r"<v>(.*?)</v>", inner, re.S)
                if vm is None:
                    continue
                if 't="s"' in attrs:
                    val = shared[int(vm.group(1))]
                else:
                    val = _unescape(vm.group(1))
                val = val.strip()
                if val:
                    cells[col] = val
            if cells:
                rows[int(rm.group(1))] = cells
        out[_unescape(name)] = rows
    return out


# ---------------------------------------------------------------- 값 변환

EPOCH = dt.date(1899, 12, 30)


def to_date(v):
    """엑셀 날짜 일련번호 또는 문자열 → date. 실패하면 None."""
    if not v:
        return None
    try:
        return EPOCH + dt.timedelta(days=int(float(v)))
    except ValueError:
        pass
    m = re.search(r"(\d{4})[-/.]\s*(\d{1,2})[-/.]\s*(\d{1,2})", v)
    if m:
        try:
            return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    return None


def to_int(v):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


_D = "영일이삼사오육칠팔구"
_SMALL = ["", "십", "백", "천"]
_BIG = [("", 1), ("만", 10**4), ("억", 10**8), ("조", 10**12)]


def _four(n):
    """0<n<10000 → '천이백이십사' 꼴. 십/백/천 앞의 '일'은 생략한다."""
    s = ""
    for pos in (3, 2, 1, 0):
        d = (n // 10**pos) % 10
        if d == 0:
            continue
        if d == 1 and pos > 0:
            s += _SMALL[pos]
        else:
            s += _D[d] + _SMALL[pos]
    return s


def kor_amount(n):
    """금액 한글표기. 5,120,000 → '오백십이만원'."""
    if n == 0:
        return "영원"
    parts = []
    for name, unit in reversed(_BIG):
        chunk = (n // unit) % 10000
        if chunk:
            parts.append(_four(chunk) + name)
    return "".join(parts) + "원"


def norm_client(s):
    """고객사명 매칭 키: 공백/괄호/기호 제거 + 소문자."""
    return re.sub(r"[\s()（）·.,\-_&]+", "", (s or "")).lower()


# ---------------------------------------------------------------- 변환 본체

COLS = list("ABCDEFGHIJKLMNOPQRSTU")


def build(sheets, month, pm):
    raw = sheets["로우데이터"]
    info = sheets["인건비 정보"]
    codes = sheets["식별코드"]

    # 실명 → 이름(식별자)
    ident = {}
    for rn, c in info.items():
        if rn == 1:
            continue
        if c.get("B") and c.get("C"):
            ident.setdefault(c["B"].strip(), c["C"].strip())

    # 정규화 고객사명 → (식별코드, 트랙명, 표준 고객사명)
    client_map = {}
    for rn, c in codes.items():
        if rn == 1:
            continue
        std = (c.get("D") or "").strip()
        if not std:
            continue
        client_map.setdefault(norm_client(std), (c.get("B", "").strip(), c.get("C", "").strip(), std))

    y, m = (int(x) for x in month.split("-"))
    first = dt.date(y, m, 1)
    last = dt.date(y + (m == 12), (m % 12) + 1, 1) - dt.timedelta(days=1)

    rows, warns = [], []
    unmatched = {}  # 원문 고객사명 → [로우데이터 행번호]
    for rn in sorted(raw):
        if rn == 1:
            continue
        c = raw[rn]
        name = (c.get("B") or "").strip()
        if not name:
            continue
        if pm and (c.get("H") or "").strip() != pm:
            continue

        start, end = to_date(c.get("C")), to_date(c.get("D"))
        if start is None and end is None:
            continue
        s_eff, e_eff = start or end, end or start
        if e_eff < first or s_eff > last:
            continue  # 대상 월과 안 겹침

        raw_client = (c.get("F") or "").strip()
        course = (c.get("G") or "").strip()
        wtype_raw = (c.get("E") or "").strip()
        amount = to_int(c.get("I"))
        tag = "로우데이터 %d행 %s" % (rn, name)

        hit = client_map.get(norm_client(raw_client))
        if hit:
            code, track, std_client = hit
        else:
            # 시트의 수식도 미매칭이면 ""를 반환한다. 임의 매칭하지 말고 원문만 남긴다.
            code, track, std_client = "", "", raw_client
            unmatched.setdefault(raw_client, []).append(rn)

        if raw_client and norm_client(name) == norm_client(raw_client):
            warns.append("성함 오기입 의심: %s — 성함 칸에 고객사명이 들어 있음" % tag)

        worktype = WORKTYPE.get(wtype_raw, "")
        if not worktype:
            warns.append("근무유형 불명: %s — 로우데이터 값 '%s' (L열 직접 선택)" % (tag, wtype_raw))

        if amount is None:
            warns.append("금액 없음: %s — 로우데이터 지급액 비어 있음" % tag)
        if start is None or end is None:
            warns.append("날짜 결측: %s — 교육시작일/종료일 한쪽이 비어 있음" % tag)
        if s_eff < first or e_eff > last:
            warns.append("월 경계 걸침: %s — %s~%s (%s 분으로 잡을지 확인)" % (tag, s_eff, e_eff, month))

        rows.append(
            {
                "row": rn,
                "person": name,
                "amount": amount or 0,
                "cells": {
                    "A": (c.get("A") or "").strip(),                        # 타임스탬프
                    "B": "",                                                # 지급 여부(재무팀 체크)
                    "C": (c.get("H") or "").strip(),                        # 작성자(담당 PM)
                    "D": ident.get(name, ""),                               # 이름(식별자)
                    "E": name,                                              # 실명
                    "F": "",                                                # 잘 썼는지 체크
                    "G": "",                                                # 체크했나요?
                    "H": s_eff.isoformat(),
                    "I": e_eff.isoformat(),
                    "J": TEAM,
                    "K": PRODUCT,
                    "L": worktype,
                    "M": track,
                    "N": code,
                    "O": "",                                                # 기수(수동)
                    "P": std_client,
                    "Q": "[%s]%s" % (raw_client, course),                   # 로우데이터 원문 표기를 쓴다
                    "R": "" if amount is None else str(amount),
                    "S": kor_amount(amount) if amount and amount >= KOR_AMOUNT_THRESHOLD else "",
                    "T": "",                                                # 참고/메모
                    "U": wtype_raw,                                         # 강사/기술튜터
                },
            }
        )

    # 미매칭 고객사는 행마다 반복하지 않고 고객사 단위로 한 줄씩 모은다
    for raw_client, rns in sorted(unmatched.items(), key=lambda kv: -len(kv[1])):
        near = suggest_clients(raw_client, client_map)
        warns.append(
            "고객사 미매칭: '%s' %d건 (로우데이터 %s행) — 식별코드 시트에 없음%s"
            % (
                raw_client,
                len(rns),
                "·".join(str(r) for r in rns),
                (" / 유사 후보: " + ", ".join(near)) if near else " / 유사 후보 없음",
            )
        )
    return rows, warns


def suggest_clients(raw_client, client_map, limit=3):
    """정규화 키의 부분 포함으로 후보를 뽑는다. 자동 적용하지 않고 사람이 고르게만 한다."""
    key = norm_client(raw_client)
    if not key:
        return []
    hits = [std for k, (_c, _t, std) in client_map.items() if k and (k in key or key in k)]
    return sorted(set(hits), key=len)[:limit]


def load_axhub(path):
    """query_sql 결과 rows 를 읽어 rates.json 시급을 곱한 계산액을 붙인다.

    입력은 person·client·title·qual·days·d1·d2·hours 를 가진 JSON 배열이다.
    단가가 없거나(main_l6 등) 시간이 NULL 이면 amount 를 None 으로 둔다 — 0 으로 깔면
    미제출·불일치가 조용히 사라진다.
    """
    with open(path, encoding="utf-8") as f:
        assigns = json.load(f)
    if isinstance(assigns, dict):  # {"rows": [...]} 형태도 받아준다
        assigns = assigns.get("rows", [])
    with open(os.path.join(HERE, "rates.json"), encoding="utf-8") as f:
        rates = json.load(f)["hourly_rates"]

    out = []
    for a in assigns:
        a = dict(a)
        rate = rates.get(a.get("qual"))
        hours = a.get("hours")
        a["role"] = qual_role(a.get("qual"))
        a["rate"] = rate
        a["amount"] = None if (rate is None or hours is None) else int(round(rate * float(hours)))
        out.append(a)
    return out


def apply_rate_memo(rows, assigns):
    """T(참고/메모)에 ax-hub 기준 시급 × 시간을 적는다.

    로우데이터에는 시급·시간 칸이 없다. 사람+기간겹침으로 ax-hub 배정을 찾아 붙이므로
    **산정 근거가 아니라 참고 수치**다 (지급액은 여전히 로우데이터 I열).
    한 행이 여러 배정에 걸치면 시급이 같은 것끼리 시간을 합치고, 다르면 ' + '로 나열한다.
    """
    filled = 0
    for r in rows:
        rs, re_ = r["cells"]["H"], r["cells"]["I"]
        hit = [
            a for a in assigns
            if a["person"] == r["person"] and not (a["d2"] < rs or a["d1"] > re_)
        ]
        if not hit:
            continue
        # 시급별로 시간 합산 (시급 미정은 시간만 표기)
        by_rate = {}
        for a in hit:
            if a.get("hours") is None:
                continue
            by_rate.setdefault(a.get("rate"), 0.0)
            by_rate[a["rate"]] += float(a["hours"])
        if not by_rate:
            continue
        parts = []
        for rate, hours in sorted(by_rate.items(), key=lambda kv: -(kv[0] or 0)):
            h = int(hours) if float(hours).is_integer() else hours
            if rate is None:
                parts.append("시급미정 × %sh" % h)
            else:
                parts.append("%s원/h × %sh" % (f"{rate:,}", h))
        memo = "ax-hub 기준 " + " + ".join(parts)
        # 같은 사람의 다른 교육이 날짜로 겹치면 시간이 합산돼 실제보다 커 보인다.
        # 어느 행이 그런지 알 수 있게 표시해 둔다 (reconcile 의 묶임 한계와 같은 원인).
        courses = {(a["client"], a["title"]) for a in hit}
        if len(courses) > 1:
            memo += " (다른 교육 %d건과 기간 겹침 — 합산치)" % (len(courses) - 1)
        r["cells"]["T"] = memo
        filled += 1
    return filled


def reconcile(rows, assigns):
    """로우데이터 행과 ax-hub 배정을 사람+기간겹침으로 묶어 교육 건별로 대조한다.

    고객사·교육명 표기가 양쪽에서 다르므로(신라면세 vs 신라면세점) 이름이 아니라 날짜로 잇는다.
    같은 교육을 날짜를 쪼개 여러 행으로 낸 경우도 한 덩어리로 묶인다.
    """
    people = sorted({r["person"] for r in rows} | {a["person"] for a in assigns})
    result = []
    for person in people:
        mine = [r for r in rows if r["person"] == person]
        theirs = [a for a in assigns if a["person"] == person]

        # 유니온-파인드: 노드는 ('R', i) / ('A', j)
        parent = {}

        def find(x):
            parent.setdefault(x, x)
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(x, y):
            rx, ry = find(x), find(y)
            if rx != ry:
                parent[rx] = ry

        for i, r in enumerate(mine):
            find(("R", i))
        for j, a in enumerate(theirs):
            find(("A", j))
        for i, r in enumerate(mine):
            rs, re_ = r["cells"]["H"], r["cells"]["I"]
            for j, a in enumerate(theirs):
                if not (a["d2"] < rs or a["d1"] > re_):
                    union(("R", i), ("A", j))

        groups = {}
        for node in list(parent):
            groups.setdefault(find(node), []).append(node)

        for _root, nodes in groups.items():
            rs = [mine[i] for kind, i in nodes if kind == "R"]
            as_ = [theirs[j] for kind, j in nodes if kind == "A"]
            raw_amt = sum(r["amount"] for r in rs)
            has_undecided = any(a["amount"] is None for a in as_)
            ax_amt = sum(a["amount"] or 0 for a in as_)

            if not as_:
                verdict = "배정없음"
            elif not rs:
                verdict = "미제출"
            elif has_undecided:
                verdict = "단가미정"
            elif raw_amt == ax_amt:
                verdict = "일치"
            else:
                verdict = "제출>계산" if raw_amt > ax_amt else "제출<계산"

            span = [d for x in rs for d in (x["cells"]["H"], x["cells"]["I"])] + \
                   [d for x in as_ for d in (x["d1"], x["d2"])]
            raw_roles = sorted({r["cells"]["U"] for r in rs if r["cells"]["U"]})
            ax_roles = sorted({a.get("role") for a in as_ if a.get("role")})
            result.append({
                "person": person,
                "verdict": verdict,
                "period": "%s~%s" % (min(span), max(span)),
                "raw_role": "·".join(raw_roles),
                "ax_role": "·".join(ax_roles),
                "role_ok": not (raw_roles and ax_roles) or bool(set(raw_roles) & set(ax_roles)),
                "raw_rows": "·".join(str(r["row"]) for r in rs),
                "raw_desc": " / ".join(r["cells"]["Q"] for r in rs),
                "raw_amount": raw_amt if rs else None,
                "ax_desc": " / ".join("[%s]%s (%s/%s %s일 %sh)" % (
                    a["client"], a["title"], a.get("role", ""), a["qual"], a["days"], a["hours"])
                    for a in as_),
                "ax_amount": None if (not as_ or has_undecided) else ax_amt,
                "diff": (raw_amt - ax_amt) if (rs and as_ and not has_undecided) else None,
            })

    order = {"제출<계산": 0, "미제출": 1, "제출>계산": 2, "배정없음": 3, "단가미정": 4, "일치": 5}
    result.sort(key=lambda x: (order.get(x["verdict"], 9), -abs(x["diff"] or 0), x["person"]))
    return result


def crosscheck(rows, path):
    """사람 단위 합계 대조. 요약 문장 리스트를 돌려준다."""
    assigns = load_axhub(path)
    expected, undecided = {}, []
    ax_roles, raw_roles = {}, {}
    for a in assigns:
        if a.get("role"):
            ax_roles.setdefault(a["person"], set()).add(a["role"])
        if a["amount"] is None:
            undecided.append("%s(%s %s)" % (a.get("person"), a.get("role"), a.get("qual")))
            continue
        expected[a["person"]] = expected.get(a["person"], 0) + a["amount"]

    got = {}
    for r in rows:
        got[r["person"]] = got.get(r["person"], 0) + r["amount"]
        if r["cells"]["U"]:
            raw_roles.setdefault(r["person"], set()).add(r["cells"]["U"])

    out, missing = [], []
    for person in sorted(set(raw_roles) & set(ax_roles)):
        if not (raw_roles[person] & ax_roles[person]):
            out.append(
                "역할 불일치: %s — 로우데이터 '%s' / ax-hub 배정 '%s' (L·U열 확인)"
                % (person, "·".join(sorted(raw_roles[person])), "·".join(sorted(ax_roles[person])))
            )
    for person, exp in sorted(expected.items()):
        actual = got.get(person)
        if actual is None:
            missing.append("%s(%s, %s원)" % (
                person, "·".join(sorted(ax_roles.get(person, {"?"}))), f"{exp:,}"))
        elif actual != exp:
            out.append(
                "금액불일치: %s — 로우데이터 %s원 / ax-hub 계산 %s원 (차 %+d원, 경비·추가 행일 수 있음)"
                % (person, f"{actual:,}", f"{exp:,}", actual - exp)
            )
    for person in sorted(got):
        if person not in expected and person not in {u.split("(")[0] for u in undecided}:
            out.append("배정없음: %s — 로우데이터 제출은 있으나 ax-hub 배정 없음 (담당 교육 여부 확인)" % person)
    if undecided:
        out.append("단가미정 %d명 — 검산 제외: %s" % (len(undecided), ", ".join(undecided)))
    if missing:
        out.append("미제출 %d명 — ax-hub 배정 있으나 로우데이터에 행 없음: %s" % (len(missing), ", ".join(missing)))
    return out


def main():
    # 모듈로 import 될 때는 건드리지 않는다 (import 측 stdout 을 닫아버린다)
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", newline="\n")
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", required=True, help="YYYY-MM")
    ap.add_argument("--pm", default="송찬호", help="담당 PM 실명. 빈 문자열이면 전체")
    ap.add_argument("--xlsx", default=DEFAULT_XLSX)
    ap.add_argument("--axhub", help="사람→계산금액 JSON 경로 (검산용, 선택)")
    ap.add_argument("--no-rate-memo", action="store_true",
                    help="T(참고/메모)에 ax-hub 기준 시급×시간을 적지 않는다")
    a = ap.parse_args()

    if not os.path.exists(a.xlsx):
        sys.exit("xlsx 없음: %s" % a.xlsx)
    mtime = dt.datetime.fromtimestamp(os.path.getmtime(a.xlsx)).date()

    rows, warns = build(load_sheets(a.xlsx), a.month, a.pm)

    memo_filled = 0
    if a.axhub and not a.no_rate_memo:
        memo_filled = apply_rate_memo(rows, load_axhub(a.axhub))

    print("# 대상: %s / 담당 PM: %s / %d행" % (a.month, a.pm or "(전체)", len(rows)))
    if a.axhub and not a.no_rate_memo:
        print("# T(참고/메모)에 ax-hub 기준 시급×시간 기입: %d/%d행" % (memo_filled, len(rows)))
    print("# 원본 xlsx 수정일: %s (오래됐으면 구글시트에서 다시 내려받을 것)" % mtime)
    total = sum(r["amount"] for r in rows)
    print("# 합계: %s원" % f"{total:,}")
    print("### TSV")
    for r in rows:
        print("\t".join(r["cells"][c] for c in COLS))

    print("### 수식행용 (로우데이터 행번호 → P 고객사명 / O 기수)")
    for r in rows:
        print("%d\t%s\t" % (r["row"], r["cells"]["P"]))

    print("### 확인필요")
    if a.axhub:
        warns += crosscheck(rows, a.axhub)
    for w in warns or ["(없음)"]:
        print("- %s" % w)


if __name__ == "__main__":
    main()
