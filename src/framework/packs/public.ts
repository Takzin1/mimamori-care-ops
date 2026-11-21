import type { IndustryPack } from "../types.ts";
import { standardScenario } from "./scenario-builder.ts";

export const PUBLIC_PACK: IndustryPack = {
  id: "public",
  version: "2026.11-demo",
  sector: "public",
  label: "自治体（福祉・防災）",
  vocabulary: {
    sectorLabel: "自治体（福祉・防災）",
    organizationLabel: "自治体",
    staffLabel: "職員",
    caseLabel: "対応",
    subjectLabel: "避難所・地区などの記号（住民の氏名は入れない）",
    subjectHint: "例: SHELTER-04",
  },
  categories: [
    { id: "shelter", label: "避難所" },
    { id: "welfare", label: "福祉部門のタスク" },
  ],
  fictional: true,
  disclaimer:
    "架空のデモ用テンプレートです。自治体の地域防災計画・承認済み手順に置き換えるまで現場には表示されません。災害時の一斉通知・緊急通報の代わりにはなりません。",
  manuals: [
    {
      key: "shelter-opening",
      category: "shelter",
      title: "避難所開設訓練",
      tags: ["避難所", "開設", "防災", "訓練", "BCP"],
      summary: "避難所の開設指示から受入開始・報告までの訓練手順（架空のデモ手順）。",
      steps: [
        { id: "pub-sh-1", text: "開設指示と承認済み手順を確認し、施設の安全点検を行う", critical: true },
        { id: "pub-sh-2", text: "担当班と連絡手段（電話・無線などの代替手段を含む）を確認する", critical: true },
        { id: "pub-sh-3", text: "受入体制を整え、開設を本部へ報告する" },
        { id: "pub-sh-4", text: "実施したタスクと時刻を記録する" },
        { id: "pub-sh-5", text: "交代要員へ引き継ぎ、振り返りを記録する" },
      ],
      defaultPriority: "critical",
    },
    {
      key: "welfare-task",
      category: "welfare",
      title: "福祉部門の対応タスク管理（安否確認依頼）",
      tags: ["福祉", "安否確認", "依頼", "割当", "タスク"],
      summary: "安否確認の依頼を受け付け、担当を割り当てて完了を確認する流れ（架空のデモ手順）。",
      steps: [
        { id: "pub-wf-1", text: "依頼内容を確認し、対応を作成する", critical: true },
        { id: "pub-wf-2", text: "担当者を割り当て、期限を共有する" },
        { id: "pub-wf-3", text: "対応結果と証跡（連絡記録など）を記録する", critical: true },
        { id: "pub-wf-4", text: "部署をまたぐ場合は引き継ぎ先の受諾を確認する" },
      ],
      defaultPriority: "normal",
    },
  ],
  trainings: [
    {
      key: "shelter-opening-drill",
      manualKey: "shelter-opening",
      title: "避難所開設（5分）",
      minutes: 5,
      passingScore: 80,
      questions: [
        {
          id: "q1",
          prompt: "通信が使えないときの連絡手段として適切なのは？",
          choices: [
            { id: "a", label: "アプリが復旧するまで待つ" },
            { id: "b", label: "計画に定めた代替手段（無線・伝令など）を使う" },
          ],
          correctChoiceId: "b",
          explanation: "アプリを唯一の手段にしません。",
          stepRef: "pub-sh-2",
        },
      ],
      scenario: standardScenario({
        prefix: "pub-sh",
        first: {
          narrative: "避難所の開設指示が出ました（訓練）。",
          prompt: "最初に行うことは？",
          right: "承認済み手順を確認し、施設の安全点検を行う",
          wrong: ["すぐに住民を入れる", "指示を確認せず待機する"],
          feedback: "安全点検の前に受け入れません。",
          stepRef: "pub-sh-1",
        },
        report: {
          narrative: "点検の結果、受け入れ可能です。",
          right: "本部へ報告し、対応を作成する",
          wrong: "報告せずに開設する",
          feedback: "本部と状況を共有します。",
          stepRef: "pub-sh-3",
        },
        start: {
          narrative: "本部があなたを開設担当にしました。",
          right: "対応を開始し、受入体制を整える",
          wrong: "交代を待つ",
          feedback: "担当として開設を進めます。",
          stepRef: "pub-sh-3",
        },
        record: {
          right: "実施タスク・時刻・報告先・課題",
          wrong: "訓練なので記録しない",
          feedback: "訓練でも記録し振り返ります。",
          stepRef: "pub-sh-4",
        },
        handoff: {
          narrative: "交代要員が到着しました。",
          feedback: "受諾されるまで担当は移りません。",
          stepRef: "pub-sh-5",
        },
        completion: {
          narrative: "交代要員が運営を引き継ぎ、訓練を終了しました。",
          summary: "訓練: 避難所開設を完了。",
          evidenceRef: "training:pub-shelter-record",
          stepRef: "pub-sh-5",
        },
      }),
    },
    {
      key: "welfare-task-drill",
      manualKey: "welfare-task",
      title: "安否確認依頼の対応管理（5分）",
      minutes: 5,
      passingScore: 80,
      questions: [
        {
          id: "q1",
          prompt: "部署をまたぐ対応で必要なのは？",
          choices: [
            { id: "a", label: "引き継ぎ先と受諾を明確にする" },
            { id: "b", label: "前の担当が完了扱いにすれば十分" },
          ],
          correctChoiceId: "a",
          explanation: "受諾まで責任は移りません。",
          stepRef: "pub-wf-4",
        },
      ],
      scenario: standardScenario({
        prefix: "pub-wf",
        first: {
          narrative: "地区から安否確認の依頼が届きました（訓練）。",
          prompt: "最初に行うことは？",
          right: "依頼内容を確認し、記録に残す",
          wrong: ["口頭で済ませる", "後回しにする"],
          feedback: "依頼を記録して見える化します。",
          stepRef: "pub-wf-1",
        },
        report: {
          narrative: "依頼は確認が必要な内容です。",
          right: "対応を作成し、担当を決める",
          wrong: "誰かが対応するだろうと待つ",
          feedback: "担当を明確にします。",
          stepRef: "pub-wf-1",
        },
        start: {
          narrative: "あなたが担当になりました。",
          right: "対応を開始し、期限を共有する",
          wrong: "期限を決めずに保留する",
          feedback: "期限を共有して進めます。",
          stepRef: "pub-wf-2",
        },
        record: {
          right: "連絡結果・時刻・証跡（連絡記録の場所）",
          wrong: "結果だけ口頭で伝える",
          feedback: "結果と証跡を残します。",
          stepRef: "pub-wf-3",
        },
        handoff: {
          narrative: "別の部署へ対応を引き継ぎます。",
          feedback: "受諾されるまで担当は移りません。",
          stepRef: "pub-wf-4",
        },
        completion: {
          narrative: "引き継ぎ先が確認を終えました。",
          summary: "訓練: 安否確認の結果を記録。",
          evidenceRef: "training:pub-welfare-record",
          stepRef: "pub-wf-3",
        },
      }),
    },
  ],
};
