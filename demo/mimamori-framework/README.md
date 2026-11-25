---
title: Mimamori Framework Lab
emoji: "🛟"
colorFrom: blue
colorTo: green
sdk: static
app_file: index.html
pinned: false
short_description: Synthetic demo of manual, training and case flows
---

# Mimamori Framework Lab（見守りフレームワーク デモ）

**Synthetic demo only — 本番運用不可。** 架空データだけで動く公開デモです。

介護・学校・医療施設（非診療業務）・自治体で共通に使える
「マニュアル → 検索 → 研修 → 対応開始 → 実行 → 引き継ぎ → 完了 → 証跡」の流れを、
ブラウザだけで試せます。

## このデモで動いているもの

- [mimamori-care-ops](https://github.com/Takzin1/mimamori-care-ops) の実際のエンジン
  （Framework の手順・検索・研修・証跡サービスと、Care Ops の Case 状態遷移・権限・SLA キュー）を
  TypeScript からそのままブラウザ向けにコンパイルしたもの。デモ専用の簡易モデルではありません。
- 記録先はブラウザのメモリだけです（再読み込みで消えます）。データベースには接続しません。
- 4業種 × 2手順の架空テンプレート（例: 転倒時の対応訓練、勤務交代時の申し送り、校内事故の報告訓練、
  防災訓練、設備故障対応、非診療業務の引き継ぎ、避難所開設訓練、福祉部門の対応タスク管理）。
  デモ内では「作成者が申請 → 別の責任者が承認」の手順を自動で通しています（架空の承認）。

## 安全上の注意

- 実在する個人情報・介護記録・診療情報は含まれていません。入力もしないでください。
- 実際の LINE 通知・緊急通報・外部送信は一切行いません。ページの Content-Security-Policy で
  外部への通信（`connect-src 'none'`）を禁止しています。
- Supabase などのキーや本番データベースへの接続情報は含まれていません。
- 実際の事故・災害・医療の判断や対応には使用できません。アプリは安全確保の唯一の手段ではありません。

## 本番利用との違い

本番では、LINE ログインをサーバー側で検証し、所属組織・ロール・権限を確認したうえで、
PostgreSQL（行レベルセキュリティ、SECURITY DEFINER RPC）に記録します。
これらはこの公開デモには含まれていません。
