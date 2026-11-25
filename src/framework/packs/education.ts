import type { IndustryPack } from "../types.ts";
import { standardScenario } from "./scenario-builder.ts";

export const EDUCATION_PACK: IndustryPack = {
  id: "education",
  version: "2026.11-demo",
  sector: "education",
  label: "学校・教育",
  vocabulary: {
    sectorLabel: "学校・教育",
    organizationLabel: "学校",
    staffLabel: "教職員",
    caseLabel: "事案",
    subjectLabel: "場所・学級などの記号（児童生徒の氏名は入れない）",
    subjectHint: "例: GYM-1 / 3-B",
  },
  categories: [
    { id: "incident", label: "校内事故" },
    { id: "disaster", label: "防災" },
  ],
  fictional: true,
  disclaimer:
    "架空のデモ用テンプレートです。学校・教育委員会の承認済み手順に置き換えるまで、現場の標準手順として表示されません。緊急通報・医療判断の代わりにはなりません。",
  manuals: [
    {
      key: "school-incident",
      category: "incident",
      title: "校内事故の報告訓練",
      tags: ["事故", "けが", "報告", "保護者連絡", "校内"],
      summary: "休み時間・授業中のけがや事故の初動と報告の流れ（架空のデモ手順）。",
      steps: [
        { id: "edu-inc-1", text: "児童生徒の安全を確保し、周囲の教職員に応援を求める", critical: true },
        { id: "edu-inc-2", text: "緊急性が高い場合は学校の緊急対応手順に従い通報・養護教諭へ連絡する", critical: true },
        { id: "edu-inc-3", text: "管理職へ報告し、保護者連絡の担当を決める" },
        { id: "edu-inc-4", text: "発生時刻・場所・状況・対応を記録する" },
        { id: "edu-inc-5", text: "未完了の事項を担当者へ引き継ぐ" },
      ],
      defaultPriority: "high",
    },
    {
      key: "disaster-drill",
      category: "disaster",
      title: "防災訓練（地震発生時の初動）",
      tags: ["防災", "地震", "避難", "点呼", "訓練"],
      summary: "地震発生時の安全確保・避難・点呼・報告の訓練手順（架空のデモ手順）。",
      steps: [
        { id: "edu-dis-1", text: "揺れている間は頭を守らせ、落下物から離れさせる", critical: true },
        { id: "edu-dis-2", text: "揺れが収まったら避難経路を確認し、指示に従って避難する", critical: true },
        { id: "edu-dis-3", text: "避難場所で点呼し、不明者の有無を本部へ報告する", critical: true },
        { id: "edu-dis-4", text: "対応と報告内容を記録し、引き継ぐ" },
      ],
      defaultPriority: "critical",
    },
  ],
  trainings: [
    {
      key: "school-incident-drill",
      manualKey: "school-incident",
      title: "校内事故の報告（5分）",
      minutes: 5,
      passingScore: 80,
      questions: [
        {
          id: "q1",
          prompt: "担当の管理職が不在のときの適切な行動は？",
          choices: [
            { id: "a", label: "報告を取りやめる" },
            { id: "b", label: "代替の責任者・連絡経路を確認して報告する" },
          ],
          correctChoiceId: "b",
          explanation: "報告経路の代替を事前に決めておきます。",
          stepRef: "edu-inc-3",
        },
      ],
      scenario: standardScenario({
        prefix: "edu-inc",
        first: {
          narrative: "昼休み、体育館で児童がうずくまっているのを見つけました（訓練）。",
          prompt: "最初に行うことは？",
          right: "安全を確保し、周囲の教職員に応援を求める",
          wrong: ["本人に教室へ戻るよう伝える", "授業の準備を優先する"],
          feedback: "まず安全確保と応援要請です。",
          stepRef: "edu-inc-1",
        },
        report: {
          narrative: "意識ははっきりしていますが、足首の痛みを訴えています。",
          right: "養護教諭・管理職へ報告し、事案を作成する",
          wrong: "放課後まで様子を見る",
          feedback: "報告を遅らせず、担当を明確にします。",
          stepRef: "edu-inc-3",
        },
        start: {
          narrative: "管理職があなたを担当にしました。",
          right: "対応を開始し、養護教諭の指示に従う",
          wrong: "自分の判断で保護者に連絡する",
          feedback: "保護者連絡の担当は管理職が決めます。",
          stepRef: "edu-inc-3",
        },
        record: {
          right: "発生時刻・場所・状況・対応・連絡先",
          wrong: "大きなけがでなければ記録しない",
          feedback: "事実と時刻を記録します。",
          stepRef: "edu-inc-4",
        },
        handoff: {
          narrative: "次の授業のため、別の教職員に対応を引き継ぎます。",
          feedback: "受諾されるまで担当は移りません。",
          stepRef: "edu-inc-5",
        },
        completion: {
          narrative: "引き継いだ教職員が保護者への連絡まで終えました。",
          summary: "訓練: 報告・連絡を完了。",
          evidenceRef: "training:edu-incident-record",
          stepRef: "edu-inc-4",
        },
      }),
    },
    {
      key: "disaster-drill-training",
      manualKey: "disaster-drill",
      title: "防災訓練：点呼と報告（5分）",
      minutes: 5,
      passingScore: 80,
      questions: [
        {
          id: "q1",
          prompt: "点呼で不明者がいたときの適切な行動は？",
          choices: [
            { id: "a", label: "直ちに本部へ報告し、指示を受ける" },
            { id: "b", label: "自分だけで校舎に戻って探す" },
          ],
          correctChoiceId: "a",
          explanation: "二次被害を防ぐため、本部の指示に従います。",
          stepRef: "edu-dis-3",
        },
      ],
      scenario: standardScenario({
        prefix: "edu-dis",
        first: {
          narrative: "授業中に強い揺れを感じました（訓練）。",
          prompt: "揺れている間に行うことは？",
          right: "頭を守らせ、落下物から離れさせる",
          wrong: ["すぐに廊下へ走らせる", "窓際に集まらせる"],
          feedback: "揺れている間は身を守ることが最優先です。",
          stepRef: "edu-dis-1",
        },
        report: {
          narrative: "避難場所で点呼すると、1名の所在が確認できません。",
          right: "本部へ報告し、事案を作成する",
          wrong: "点呼をやり直すまで報告しない",
          feedback: "不明者の情報は直ちに本部へ。",
          stepRef: "edu-dis-3",
        },
        start: {
          narrative: "本部があなたを確認担当にしました。",
          right: "対応を開始し、本部の指示に従って確認する",
          wrong: "単独で校舎へ戻る",
          feedback: "二次被害を防ぐため指示に従います。",
          stepRef: "edu-dis-3",
        },
        record: {
          right: "点呼結果・時刻・報告先・指示内容",
          wrong: "訓練なので記録しない",
          feedback: "訓練でも記録を残し振り返ります。",
          stepRef: "edu-dis-4",
        },
        handoff: {
          narrative: "別の担当に確認を引き継ぐことになりました。",
          feedback: "受諾されるまで担当は移りません。",
          stepRef: "edu-dis-4",
        },
        completion: {
          narrative: "所在が確認できました。",
          summary: "訓練: 所在確認を完了。",
          evidenceRef: "training:edu-disaster-record",
          stepRef: "edu-dis-4",
        },
      }),
    },
  ],
};
