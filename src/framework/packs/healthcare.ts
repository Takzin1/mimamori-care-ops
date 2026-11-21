import type { IndustryPack } from "../types.ts";
import { standardScenario } from "./scenario-builder.ts";

/** Non-clinical hospital operations only: facilities, logistics, handoffs. No diagnosis or treatment content. */
export const HEALTHCARE_PACK: IndustryPack = {
  id: "healthcare",
  version: "2026.11-demo",
  sector: "healthcare",
  label: "医療施設（非診療業務）",
  vocabulary: {
    sectorLabel: "医療施設（非診療業務）",
    organizationLabel: "病院",
    staffLabel: "職員",
    caseLabel: "案件",
    subjectLabel: "設備・区画の記号（患者情報は入れない）",
    subjectHint: "例: B1-AHU-2",
  },
  categories: [
    { id: "facility", label: "設備" },
    { id: "handoff", label: "業務の引き継ぎ" },
  ],
  fictional: true,
  disclaimer:
    "架空のデモ用テンプレートです。非診療業務（設備・物品・施設運営）に限ります。診療・医療判断は扱いません。病院の承認済み手順に置き換えるまで現場には表示されません。",
  manuals: [
    {
      key: "equipment-failure",
      category: "facility",
      title: "設備故障対応（空調・給水など）",
      tags: ["設備", "故障", "空調", "給水", "停電", "施設管理"],
      summary: "共用設備の異常を把握し、設備管理担当へ確実に引き継ぐ流れ（架空のデモ手順）。",
      steps: [
        { id: "hc-eq-1", text: "異常の範囲を確認し、立入制限など安全上のルールに従う", critical: true },
        { id: "hc-eq-2", text: "医療機器・重要区画への影響がある場合は施設の緊急手順に従い責任者へ連絡する", critical: true },
        { id: "hc-eq-3", text: "設備管理担当へ連絡し、案件を作成する" },
        { id: "hc-eq-4", text: "実施した連絡・対応を記録する" },
        { id: "hc-eq-5", text: "復旧担当へ引き継ぎ、完了を確認する" },
      ],
      defaultPriority: "high",
    },
    {
      key: "nonclinical-handoff",
      category: "handoff",
      title: "非診療業務の引き継ぎ（夜間の施設管理）",
      tags: ["引き継ぎ", "夜間", "施設管理", "物品", "申し送り"],
      summary: "夜間帯の施設管理・物品手配などの未完了業務を引き継ぐ流れ（架空のデモ手順）。",
      steps: [
        { id: "hc-ho-1", text: "対応中の非診療案件と未完了タスクを確認する", critical: true },
        { id: "hc-ho-2", text: "次の担当へ依頼し、受諾を確認する", critical: true },
        { id: "hc-ho-3", text: "受諾時刻と申し送り内容を記録する" },
      ],
      defaultPriority: "normal",
    },
  ],
  trainings: [
    {
      key: "equipment-failure-drill",
      manualKey: "equipment-failure",
      title: "設備故障の連絡・引き継ぎ（5分）",
      minutes: 5,
      passingScore: 80,
      questions: [
        {
          id: "q1",
          prompt: "対応状況の記録として必要なのは？",
          choices: [
            { id: "a", label: "担当・時刻・結果を残す" },
            { id: "b", label: "口頭で伝えて記録は残さない" },
          ],
          correctChoiceId: "a",
          explanation: "誰がいつ何をしたかを残します。",
          stepRef: "hc-eq-4",
        },
      ],
      scenario: standardScenario({
        prefix: "hc-eq",
        first: {
          narrative: "地下の機械室付近で水漏れを見つけました（訓練）。",
          prompt: "最初に行うことは？",
          right: "範囲を確認し、立入制限など安全ルールに従う",
          wrong: ["自分で配管を修理する", "後で報告すればよいので持ち場に戻る"],
          feedback: "安全確保と範囲の把握が先です。",
          stepRef: "hc-eq-1",
        },
        report: {
          narrative: "重要区画への影響はなさそうです。",
          right: "設備管理担当へ連絡し、案件を作成する",
          wrong: "翌朝まで連絡しない",
          feedback: "担当へ確実に連絡し、記録で共有します。",
          stepRef: "hc-eq-3",
        },
        start: {
          narrative: "設備担当があなたを一次対応にしました。",
          right: "対応を開始し、指示どおり周囲の安全を保つ",
          wrong: "立入制限を外して作業を待つ",
          feedback: "指示に従って安全を保ちます。",
          stepRef: "hc-eq-1",
        },
        record: {
          right: "発見時刻・場所・範囲・連絡先・対応",
          wrong: "記録は不要",
          feedback: "事実と時刻を残します。",
          stepRef: "hc-eq-4",
        },
        handoff: {
          narrative: "復旧担当が到着しました。",
          feedback: "受諾されるまで担当は移りません。",
          stepRef: "hc-eq-5",
        },
        completion: {
          narrative: "復旧担当が修理を終えました。",
          summary: "訓練: 設備の復旧を確認。",
          evidenceRef: "training:hc-equipment-record",
          stepRef: "hc-eq-5",
        },
      }),
    },
    {
      key: "nonclinical-handoff-drill",
      manualKey: "nonclinical-handoff",
      title: "夜間の業務引き継ぎ（5分）",
      minutes: 5,
      passingScore: 80,
      questions: [
        {
          id: "q1",
          prompt: "引き継ぎが完了したといえるのは？",
          choices: [
            { id: "a", label: "相手が受諾したとき" },
            { id: "b", label: "メモを置いたとき" },
          ],
          correctChoiceId: "a",
          explanation: "受諾の確認が完了の条件です。",
          stepRef: "hc-ho-2",
        },
      ],
      scenario: standardScenario({
        prefix: "hc-ho",
        first: {
          narrative: "夜間帯の終了前、物品の手配が1件残っています（訓練）。",
          prompt: "まず行うことは？",
          right: "対応中の案件と未完了タスクを確認する",
          wrong: ["そのまま退勤する", "口頭だけで伝える"],
          feedback: "未完了を把握してから引き継ぎます。",
          stepRef: "hc-ho-1",
        },
        report: {
          narrative: "朝までに手配が必要です。",
          right: "案件を作成して担当を明確にする",
          wrong: "メモを残すだけにする",
          feedback: "担当を明確にします。",
          stepRef: "hc-ho-1",
        },
        start: {
          narrative: "あなたが担当になりました。",
          right: "対応を開始し、経過を記録する",
          wrong: "交代まで何もしない",
          feedback: "担当として対応を進めます。",
          stepRef: "hc-ho-1",
        },
        record: {
          right: "手配状況・時刻・次の確認事項",
          wrong: "記録しない",
          feedback: "次の担当が判断できる情報を残します。",
          stepRef: "hc-ho-3",
        },
        handoff: {
          narrative: "日勤の担当が来ました。",
          feedback: "受諾を確認してから交代します。",
          stepRef: "hc-ho-2",
        },
        completion: {
          narrative: "日勤の担当が手配を完了しました。",
          summary: "訓練: 物品手配を完了。",
          evidenceRef: "training:hc-handoff-record",
          stepRef: "hc-ho-3",
        },
      }),
    },
  ],
};
