/**
 * 수강 신청 접수구 — Claude 원데이 클래스 랜딩 (code-creation-pro)
 *
 * 이 파일이 정본이다. 스크립트를 수정하면 이 파일도 함께 갱신할 것.
 *
 * ── 시트 열 순서 (절대 바꾸지 말 것. 랜딩 코드와 짝을 이룬다) ──────────
 *   A 신청일시   B 이름       C 회사명     D 직무
 *   E 연락처     F 이메일     G 희망일정   H 참석인원
 *   I 결제금액   J AI경험     K 자동화희망업무
 *   L 문의내용   M 동반참석자
 *   N 개인정보동의  O 동의시각  P 신청ID      ← 2026-07 추가
 *   Q 발송여부   R 발송일시                  ← 2026-08 추가 (견적서 메일 발송 표시)
 *
 * ── 배포 방법 (중요) ────────────────────────────────────────────────
 *   1) 코드 붙여넣고 저장
 *   2) 배포 > 배포 관리 > (기존 배포) 연필 아이콘 > 버전: "새 버전" 선택 > 배포
 *      ※ 저장만 하면 반영되지 않는다. 반드시 새 버전으로 배포해야 한다.
 *      ※ 새로 "배포"를 만들면 URL이 바뀌어 랜딩이 끊긴다. 기존 배포를 수정할 것.
 *   3) 액세스 권한: "모든 사용자(Anyone)" 유지
 *   4) 확인: 배포 URL을 브라우저 주소창에 그냥 열어본다.
 *      {"result":"success","message":"alive"} 가 보이면 정상.
 *
 * ── 변경 이력 ──────────────────────────────────────────────────────
 *   2026-07-28  잠금 실패 시 조용히 넘어가던 문제 수정,
 *               개인정보 동의·동의시각 기록, 신청ID로 중복 접수 방지,
 *               배포 상태 확인용 doGet 추가
 *   2026-08-04  견적서 메일 발송 표시 기능 추가 (action:'markSent').
 *               랜딩의 신청 접수 요청은 action이 없으므로 기존과 동일하게 동작한다.
 *               정본 사본: .claude/skills/oneday-class-quote/Code.gs
 */

var SUBMISSION_ID_COLUMN = 16; // P열

// ── 발송 표시용 설정 ────────────────────────────────────────────────
// 아래 TOKEN 과 같은 값을 프로젝트 .env 의 ONEDAY_SHEET_TOKEN 에 넣는다.
var MARK_TOKEN = 'oneday-class-2026';
var MARK_ID_HEADER = '신청 ID';
var MARK_SENT_HEADER = '발송여부';
var MARK_SENT_AT_HEADER = '발송일시';

function doPost(e) {
  var raw = e && e.postData ? e.postData.contents : '{}';
  var data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return jsonResponse({ result: 'error', message: 'invalid json' });
  }

  // 발송 표시 요청. 랜딩의 접수 요청에는 action 이 없으므로 아래로 내려간다.
  if (data.action === 'markSent') {
    if (data.token !== MARK_TOKEN) {
      return jsonResponse({ result: 'error', message: 'invalid token' });
    }
    if (!data.id) {
      return jsonResponse({ result: 'error', message: 'id is required' });
    }
    return jsonResponse(markSent(String(data.id), data.note || '', data.status || '발송완료'));
  }

  return receiveSubmission(data);
}

/** 랜딩에서 들어오는 신청 접수 (기존 동작 그대로) */
function receiveSubmission(data) {
  var lock = LockService.getScriptLock();

  // 잠금을 못 잡았는데 그냥 진행하면 동시 제출 시 행이 어긋난다.
  // 저장하지 않고 실패를 알려서 신청자가 다시 시도하게 한다.
  if (!lock.tryLock(15000)) {
    return jsonResponse({ result: 'error', message: 'busy' });
  }

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

    // 같은 신청ID가 이미 있으면 다시 쓰지 않는다.
    // 전송 확인이 실패해 신청자가 버튼을 다시 눌러도 중복 행이 생기지 않게 한다.
    var submissionId = data.submissionId || '';
    if (submissionId && hasSubmissionId(sheet, submissionId)) {
      return jsonResponse({ result: 'success', duplicate: true });
    }

    sheet.appendRow([
      new Date(),                              // A 신청일시
      data.name || '',                         // B
      data.company || '',                      // C
      data.position || '',                     // D
      data.phone || '',                        // E
      data.email || '',                        // F
      data.schedule || '',                     // G
      data.attendeeCount || 1,                 // H
      data.totalPrice || '',                   // I
      data.aiExperience || '',                 // J
      data.taskToAutomate || '',               // K
      data.inquiry || '',                      // L
      data.additionalAttendees || '',          // M
      data.privacyConsent ? '동의' : '',        // N 개인정보동의
      data.consentedAt || '',                  // O 동의시각
      submissionId                             // P 신청ID
    ]);

    return jsonResponse({ result: 'success' });
  } catch (error) {
    return jsonResponse({ result: 'error', message: String(error) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 배포가 살아 있는지 브라우저에서 바로 확인하기 위한 용도.
 * ?action=sentStatus&token=... 이면 행별 발송 표시 상태를 돌려준다.
 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'sentStatus') {
    if (p.token !== MARK_TOKEN) {
      return jsonResponse({ result: 'error', message: 'invalid token' });
    }
    return jsonResponse(sentStatus());
  }
  return jsonResponse({ result: 'success', message: 'alive' });
}

/** 신청ID로 행을 찾아 Q·R 열에 발송 표시를 남긴다. A~P 열은 건드리지 않는다. */
function markSent(id, note, status) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { result: 'error', message: 'busy' };
  }
  try {
    var ctx = markContext();
    if (ctx.idCol < 0) {
      return { result: 'error', message: '헤더에 "' + MARK_ID_HEADER + '" 열이 없습니다' };
    }

    // 발송여부·발송일시 열이 없으면 마지막 열 뒤에 만든다.
    var sentCol = ctx.sentCol;
    var sentAtCol = ctx.sentAtCol;
    var nextCol = ctx.header.length;
    if (sentCol < 0) {
      sentCol = nextCol;
      ctx.sheet.getRange(1, sentCol + 1).setValue(MARK_SENT_HEADER);
      nextCol++;
    }
    if (sentAtCol < 0) {
      sentAtCol = nextCol;
      ctx.sheet.getRange(1, sentAtCol + 1).setValue(MARK_SENT_AT_HEADER);
    }

    for (var r = 1; r < ctx.values.length; r++) {
      if (String(ctx.values[r][ctx.idCol]).trim() !== String(id).trim()) continue;
      var stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
      ctx.sheet.getRange(r + 1, sentCol + 1).setValue(status);
      ctx.sheet.getRange(r + 1, sentAtCol + 1).setValue(stamp + (note ? ' / ' + note : ''));
      return { result: 'success', row: r + 1, id: id, status: status, sent_at: stamp };
    }
    return { result: 'error', message: '해당 신청 ID를 찾을 수 없습니다: ' + id };
  } catch (error) {
    return { result: 'error', message: String(error) };
  } finally {
    lock.releaseLock();
  }
}

function sentStatus() {
  var ctx = markContext();
  if (ctx.idCol < 0) {
    return { result: 'error', message: '헤더에 "' + MARK_ID_HEADER + '" 열이 없습니다' };
  }
  var rows = [];
  for (var r = 1; r < ctx.values.length; r++) {
    rows.push({
      id: ctx.values[r][ctx.idCol],
      sent: ctx.sentCol >= 0 ? ctx.values[r][ctx.sentCol] : '',
      sent_at: ctx.sentAtCol >= 0 ? ctx.values[r][ctx.sentAtCol] : ''
    });
  }
  return { result: 'success', rows: rows };
}

function markContext() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var values = sheet.getDataRange().getValues();
  var header = values[0] || [];
  var find = function (name) {
    for (var i = 0; i < header.length; i++) {
      if (String(header[i]).trim() === name) return i;
    }
    return -1;
  };
  return {
    sheet: sheet,
    values: values,
    header: header,
    idCol: find(MARK_ID_HEADER),
    sentCol: find(MARK_SENT_HEADER),
    sentAtCol: find(MARK_SENT_AT_HEADER)
  };
}

function hasSubmissionId(sheet, submissionId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var ids = sheet.getRange(2, SUBMISSION_ID_COLUMN, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(submissionId)) return true;
  }
  return false;
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
