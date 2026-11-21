import type { IndustryPack } from "../types.ts";
import { standardScenario } from "./scenario-builder.ts";

export const CARE_PACK: IndustryPack = {
  id: "care",
  version: "2026.11-demo",
  sector: "care",
  label: "介護・福祉",
  vocabulary: {
    sectorLabel: "介護・福祉",
    organizationLabel: "施設",
    staffLabel: "職員",
    caseLabel: "対応",
    subjectLabel: "対象（居室番号などの記号。氏名は入れない）",
    subjectHint: "例: 2F-203",
  },
  categories: [
    { id: "incident", label: "事故・急変" },
    { id: "handoff", label: "申し送り・引き継ぎ" },
  ],
  fictional: true,
  disclaimer:
    "架空のデモ用テンプレートです。導入先の責任者・専門職が内容を確認し承認するまで、現場の標準手順として表示されません。緊急通報・医療判断の代わりにはなりません。",
  manuals: [
    {
      key: "fall-response",
      category: "incident",
      title: "転倒時の対応訓練",
      tags: ["転倒", "事故", "報告", "記録"],
      summary: "居室・共用部で転倒を発見したときの初動・報告・記録の流れ（架空のデモ手順）。",
      steps: [
        { id: "care-fall-1", text: "そばを離れず声をかけ、反応と呼吸を確認して応援を呼ぶ", critical: true },
        { id: "care-fall-2", text: "緊急性が高い場合は施設の緊急通報手順に従い、看護師・責任者へ連絡する", critical: true },
        { id: "care-fall-3", text: "痛みがある場合は無理に動かさず、状態を確認する", critical: true },
        { id: "care-fall-4", text: "対応を記録し、担当・経過を共有する" },
        { id: "care-fall-5", text: "勤務交代時は引き継ぎ先の受諾を確認する" },
      ],
      defaultPriority: "high",
    },
    {
      key: "shift-handoff",
      category: "handoff",
      title: "勤務交代時の申し送り",
      tags: ["申し送り", "引き継ぎ", "交代", "夜勤"],
      summary: "勤務交代時に未完了の対応と注意事項を確実に引き継ぐ流れ（架空のデモ手順）。",
      steps: [
        { id: "care-ho-1", text: "対応中の案件と未完了のタスクを一覧で確認する", critical: true },
        { id: "care-ho-2", text: "次の担当者へ必要な事項を伝え、引き継ぎを依頼する" },
        { id: "care-ho-3", text: "相手が受諾したことを確認してから交代する", critical: true },
        { id: "care-ho-4", text: "受諾の時刻と内容を記録する" },
      ],
      defaultPriority: "normal",
    },
  ],
  trainings: [
    {
      key: "fall-response-drill",
      manualKey: "fall-response",
      title: "転倒時の対応（5分）",
      minutes: 5,
      passingScore: 80,
      questions: [
        {
          id: "q1",
          prompt: "転倒を発見したとき、最初に行うことは？",
          choices: [
            { id: "a", label: "すぐに抱き起こしてベッドへ戻す" },
            { id: "b", label: "そばを離れず声をかけ、反応と呼吸を確認して応援を呼ぶ" },
          ],
          correctChoiceId: "b",
          explanation: "一人で離れず、反応・呼吸を確認し、周囲の職員を呼びます。",
          stepRef: "care-fall-1",
        },
        {
          id: "q2",
          prompt: "対応を完了にしてよいのは？",
          choices: [
            { id: "a", label: "手順を開いた時点" },
            { id: "b", label: "担当者・結果・引き継ぎ・証跡を確認したとき" },
          ],
          correctChoiceId: "b",
          explanation: "完了には結果と証跡が必要です。",
          stepRef: "care-fall-4",
        },
      ],
      scenario: standardScenario({
        prefix: "care-fall",
        first: {
          narrative: "夜間巡視中、居室で入居者が床に座り込んでいるのを発見しました（訓練）。",
          prompt: "最初に行うことは？",
          right: "そばを離れず声をかけ、反応と呼吸を確認して応援を呼ぶ",
          wrong: ["すぐに抱き起こしてベッドへ戻す", "先に記録を書く"],
          feedback: "一人で離れず、反応・呼吸を確認し、応援を呼びます。",
          stepRef: "care-fall-1",
        },
        report: {
          narrative: "反応・呼吸に異常はなく、腰の痛みを訴えています。",
          right: "施設の手順に従い看護師・リーダーへ報告し、対応を作成する",
          wrong: "朝の申し送りまで報告しない",
          feedback: "自己判断せず報告し、誰が何をしているかを共有します。",
          stepRef: "care-fall-2",
        },
        start: {
          narrative: "リーダーが受け付け、あなたを担当にしました。看護師から複数名での移動と保温の指示がありました。",
          right: "対応を開始し、指示どおり複数名で安全に移動・保温する",
          wrong: "一人で急いで移動させる",
          feedback: "移動は複数名で、指示に従います。",
          stepRef: "care-fall-3",
        },
        record: {
          right: "発見時刻・場所・状況・確認内容・対応・報告先",
          wrong: "けががなければ記録は不要",
          feedback: "事実と時刻を記録します。",
          stepRef: "care-fall-4",
        },
        handoff: {
          narrative: "勤務交代の時間になりました。対応はまだ続いています。",
          feedback: "受諾されるまで担当は移りません。責任の空白を作らないためです。",
          stepRef: "care-fall-5",
        },
        completion: {
          narrative: "交代した職員が経過を確認し、対応を終えました。",
          summary: "訓練: 指示どおり対応し経過観察。",
          evidenceRef: "training:care-fall-record",
          stepRef: "care-fall-4",
        },
      }),
    },
    {
      key: "shift-handoff-drill",
      manualKey: "shift-handoff",
      title: "勤務交代時の申し送り（5分）",
      minutes: 5,
      passingScore: 80,
      questions: [
        {
          id: "q1",
          prompt: "申し送りの完了確認として適切なのは？",
          choices: [
            { id: "a", label: "相手が受諾したことを確認する" },
            { id: "b", label: "送信ボタンを押しただけで完了とする" },
          ],
          correctChoiceId: "a",
          explanation: "受諾されるまで担当は移りません。",
          stepRef: "care-ho-3",
        },
      ],
      scenario: standardScenario({
        prefix: "care-ho",
        first: {
          narrative: "夜勤終了30分前です。対応中の案件が1件あります（訓練）。",
          prompt: "交代前にまず行うことは？",
          right: "対応中の案件と未完了のタスクを確認する",
          wrong: ["何もせず交代を待つ", "口頭だけで伝えて記録しない"],
          feedback: "未完了の対応を把握してから引き継ぎます。",
          stepRef: "care-ho-1",
        },
        report: {
          narrative: "見守りが必要な入居者がいます。",
          right: "対応を作成して共有する",
          wrong: "メモを机に置いておく",
          feedback: "誰が担当かを記録で共有します。",
          stepRef: "care-ho-2",
        },
        start: {
          narrative: "あなたが担当になりました。",
          right: "対応を開始し、経過を記録する",
          wrong: "交代まで何もしない",
          feedback: "担当として対応を開始します。",
          stepRef: "care-ho-2",
        },
        record: {
          right: "注意事項・時刻・次に確認すること",
          wrong: "特に記録しない",
          feedback: "次の担当が判断できる情報を残します。",
          stepRef: "care-ho-4",
        },
        handoff: {
          narrative: "早番の職員が出勤しました。",
          feedback: "相手の受諾を確認してから交代します。",
          stepRef: "care-ho-3",
        },
        completion: {
          narrative: "早番の職員が確認を終えました。",
          summary: "訓練: 申し送り事項を確認し完了。",
          evidenceRef: "training:care-handoff-record",
          stepRef: "care-ho-4",
        },
      }),
    },
  ],
};
