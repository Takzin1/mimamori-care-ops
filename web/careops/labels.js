export const STATUS = {
  NEW: "未確認",
  ACKNOWLEDGED: "確認済み",
  TRIAGED: "判断済み",
  ASSIGNED: "担当割当済み",
  IN_PROGRESS: "対応中",
  HANDOFF_PENDING: "引継ぎ待ち",
  COMPLETED: "解決済み",
  CLOSED: "クローズ",
};

export const STATUS_ICON = {
  NEW: "●",
  ACKNOWLEDGED: "◐",
  TRIAGED: "◑",
  ASSIGNED: "▲",
  IN_PROGRESS: "▶",
  HANDOFF_PENDING: "⇄",
  COMPLETED: "✓",
  CLOSED: "■",
};

export const PRIORITY = { critical: "重大", high: "高", normal: "中", low: "低" };

export const SIGNAL_TYPE = {
  non_response: "応答なし",
  unwell: "体調不良",
  sos: "SOS",
  snow_report: "雪害等の報告",
  free_text: "自由記述メッセージ",
  crisis_no_response: "緊急・応答なし",
  welfare_need_help: "生活支援の要請",
  manual: "職員の手入力",
  external_api: "外部システム連携",
};

export const DISPOSITION = {
  pending: "未処理",
  case_created: "Case作成済み",
  linked: "既存Caseに紐付け（重複）",
  dismissed: "対応不要として記録",
};

export const OUTCOME = {
  confirmed_safe: "本人の安全を確認",
  family_confirmed: "家族が確認",
  visit_completed: "訪問して対応完了",
  support_connected: "支援先につないだ",
  supplies_delivered: "物資を届けた",
  emergency_handoff_completed: "救急・医療機関への引継ぎ完了",
  false_alarm: "誤報",
  declined: "本人が支援を辞退",
  other: "その他",
};

export const EVIDENCE = {
  note: "記録メモ",
  call: "通話記録",
  visit: "訪問記録",
  message: "メッセージ",
  external_ref: "外部記録の参照",
};

export const NOTE_KIND = {
  observation: "様子確認（最終確認日時を更新）",
  action: "対応を実施",
  contact: "家族・関係者へ連絡",
  other: "その他",
};

export const ROLE = {
  dispatcher: "受付・調整",
  responder: "対応職員",
  supervisor: "管理者",
  auditor: "監査",
};

export const STAGE = {
  acknowledge: "確認",
  assign: "担当割当",
  first_action: "初動",
  handoff_accept: "引継ぎ受領",
  complete: "解決",
  critical_unacknowledged: "重大Caseの未確認",
};

export const COMMAND = {
  set_priority: { label: "優先度を変更", danger: false },
  acknowledge: { label: "確認した（受付）", danger: false, confirm: "このCaseを確認済みにします。よろしいですか？" },
  triage: { label: "判断を記録（トリアージ）", danger: false },
  assign: { label: "担当を割り当てる", danger: false },
  reassign: { label: "担当を変更（代理対応）", danger: true },
  start_action: { label: "対応を開始する", danger: false, confirm: "対応を開始します。よろしいですか？" },
  add_note: { label: "対応履歴を追加", danger: false },
  escalate: { label: "エスカレーション", danger: true },
  clear_escalation: { label: "エスカレーションを解除", danger: false },
  request_handoff: { label: "引継ぎを依頼", danger: false },
  accept_handoff: { label: "引継ぎを受領する", danger: false, confirm: "このCaseの担当を引き受けます。受領後はあなたが担当者です。" },
  decline_handoff: { label: "引継ぎを差し戻す", danger: true },
  cancel_handoff: { label: "引継ぎ依頼を取り消す", danger: false },
  complete: { label: "解決を記録", danger: true },
  close: { label: "クローズ", danger: true, confirm: "解決済みのCaseをクローズします。よろしいですか？" },
  reopen: { label: "再オープン", danger: true },
};

export const EVENT = {
  case_created: "Case作成",
  priority_changed: "優先度変更",
  acknowledged: "確認",
  triaged: "トリアージ",
  assigned: "担当割当",
  reassigned: "担当変更",
  action_started: "対応開始",
  note_added: "対応履歴",
  escalated: "エスカレーション",
  escalation_cleared: "エスカレーション解除",
  handoff_requested: "引継ぎ依頼",
  handoff_accepted: "引継ぎ受領",
  handoff_declined: "引継ぎ差し戻し",
  handoff_cancelled: "引継ぎ取消",
  signal_linked: "重複通知を紐付け",
  completed: "解決",
  closed: "クローズ",
  reopened: "再オープン",
};

export const AUDIT_FIELD = {
  status: "ステータス",
  priority: "優先度",
  priorityRationale: "優先度の根拠",
  category: "区分",
  assigneeId: "担当者",
  handoffTargetId: "引継ぎ先",
  escalation: "エスカレーション",
  facilityId: "施設",
  reopenedCount: "再オープン回数",
  linkedSignalCount: "紐付け通知数",
};

export const AI_KIND = {
  case_summary: "Caseサマリー下書き",
  handoff: "引継ぎ文面の下書き",
  fact_extraction: "重要事実の抽出",
};

export const AI_STATUS = {
  pending_review: "職員の確認待ち",
  approved: "職員が承認",
  rejected: "却下",
  failed: "生成失敗",
};

export const entries = (map) => Object.entries(map).map(([value, label]) => [value, typeof label === "string" ? label : label.label]);
