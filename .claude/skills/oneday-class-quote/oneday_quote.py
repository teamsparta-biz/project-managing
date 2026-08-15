#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""원데이 클래스 견적서 안내 메일 스킬 헬퍼.

subcommands:
  filter --ids "id1,id2"          처리기록에 없는(=미발송) 신청 ID만 출력
  status [--ids "id1,id2"]        처리기록 조회 (JSON). --ids 주면 해당 ID의 발송여부만
  mark   --ids "id1" --note "..."  발송 완료 기록 추가
  quote  --template T --out O --field k=v ...   견적서 양식 placeholder 치환
"""
import argparse
import base64
import json
import os
import sys
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))
_HERE = os.path.dirname(os.path.abspath(__file__))  # .claude/skills/oneday-class-quote
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_HERE)))  # -> repo root
RECORD = os.path.join(ROOT, "data", ".oneday_class_sent.json")


def load_record():
    if not os.path.exists(RECORD):
        return {}
    try:
        with open(RECORD, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        sys.exit("처리기록을 읽을 수 없습니다 (%s): %s\n손상된 파일을 확인하세요." % (RECORD, e))
    # 구버전(단순 ID 배열) 호환
    if isinstance(data, list):
        return {i: {"sent_at": None, "note": ""} for i in data}
    return data


def save_record(rec):
    os.makedirs(os.path.dirname(RECORD), exist_ok=True)
    tmp = RECORD + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=2)
    os.replace(tmp, RECORD)


def split_ids(raw):
    return [x.strip() for x in (raw or "").split(",") if x.strip()]


def cmd_filter(args):
    rec = load_record()
    ids = split_ids(args.ids)
    if not ids:
        sys.exit("--ids 가 비어 있습니다.")
    new = [i for i in ids if i not in rec]
    for i in new:
        print(i)
    print("--- 신규 %d건 / 전체 %d건 / 기발송 %d건" % (len(new), len(ids), len(ids) - len(new)),
          file=sys.stderr)


def cmd_status(args):
    rec = load_record()
    ids = split_ids(args.ids)
    if ids:
        out = {i: rec.get(i) for i in ids}
    else:
        out = rec
    print(json.dumps(out, ensure_ascii=False, indent=2))


def cmd_mark(args):
    rec = load_record()
    ids = split_ids(args.ids)
    if not ids:
        sys.exit("--ids 가 비어 있습니다.")
    now = datetime.now(KST).isoformat(timespec="seconds")
    for i in ids:
        if i in rec:
            print("이미 기록됨, 건너뜀: %s" % i, file=sys.stderr)
            continue
        rec[i] = {"sent_at": now, "note": args.note or ""}
        print("기록: %s (%s)" % (i, args.note or ""))
    save_record(rec)


def cmd_quote(args):
    try:
        import openpyxl
    except ImportError:
        sys.exit("openpyxl 이 필요합니다: python -m pip install openpyxl")

    if not os.path.exists(args.template):
        sys.exit("견적서 양식을 찾을 수 없습니다: %s" % args.template)

    fields = {}
    for f in args.field or []:
        if "=" not in f:
            sys.exit("--field 는 key=value 형식입니다: %s" % f)
        k, v = f.split("=", 1)
        fields[k.strip()] = v

    cells = {}
    for c in args.cell or []:
        if "=" not in c:
            sys.exit("--cell 은 COORD=value 형식입니다: %s" % c)
        k, v = c.split("=", 1)
        cells[k.strip().upper()] = v

    wb = openpyxl.load_workbook(args.template)
    replaced, remaining = set(), set()
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if not isinstance(cell.value, str) or "{{" not in cell.value:
                    continue
                text = cell.value
                for k, v in fields.items():
                    token = "{{%s}}" % k
                    if token in text:
                        text = text.replace(token, v)
                        replaced.add(k)
                cell.value = text
                # 남은 placeholder 수집
                rest = text
                while "{{" in rest and "}}" in rest:
                    s = rest.index("{{")
                    e = rest.index("}}", s)
                    remaining.add(rest[s + 2:e])
                    rest = rest[e + 2:]

    # 좌표 지정 셀 채우기 (placeholder가 없는 실제 양식용)
    ws0 = wb.worksheets[0] if not args.sheet else wb[args.sheet]
    for coord, raw in cells.items():
        try:
            val = int(raw)
        except ValueError:
            try:
                val = float(raw)
            except ValueError:
                val = raw
        ws0[coord] = val
        print("셀 %s = %r" % (coord, val))

    out = args.out
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    wb.save(out)

    size = os.path.getsize(out)
    b64len = len(base64.b64encode(open(out, "rb").read()))
    print("견적서 생성: %s" % out)
    print("치환된 필드: %s" % (", ".join(sorted(replaced)) or "(없음)"))
    unused = sorted(set(fields) - replaced)
    if unused:
        print("양식에 없어 사용되지 않은 필드: %s" % ", ".join(unused))
    if remaining:
        print("!! 채워지지 않은 placeholder: %s" % ", ".join(sorted(remaining)))
    print("파일 크기: %d bytes / base64 %d chars" % (size, b64len))
    if b64len > 30000:
        print("!! base64 가 30,000자를 넘습니다 — 첨부 불가. 수동 첨부로 안내하세요.")


def main():
    p = argparse.ArgumentParser(description="원데이 클래스 견적서 메일 스킬 헬퍼")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("filter", help="미발송 신청 ID만 출력")
    f.add_argument("--ids", required=True)
    f.set_defaults(func=cmd_filter)

    s = sub.add_parser("status", help="처리기록 조회")
    s.add_argument("--ids")
    s.set_defaults(func=cmd_status)

    m = sub.add_parser("mark", help="발송 완료 기록")
    m.add_argument("--ids", required=True)
    m.add_argument("--note", default="")
    m.set_defaults(func=cmd_mark)

    q = sub.add_parser("quote", help="견적서 양식 placeholder 치환")
    q.add_argument("--template", required=True)
    q.add_argument("--out", required=True)
    q.add_argument("--field", action="append", help="{{placeholder}} 치환: 키=값")
    q.add_argument("--cell", action="append", help="셀 좌표 직접 지정: C4=값")
    q.add_argument("--sheet", help="--cell 대상 시트명 (기본: 첫 번째 시트)")
    q.set_defaults(func=cmd_quote)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
