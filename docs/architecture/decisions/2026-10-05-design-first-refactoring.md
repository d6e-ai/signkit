# 設計を優先した段階的リファクタリング

Date: 2026-10-05

Status: proposed — 実装の採用決定ではない

計画範囲は[2026-10-11の全体対象・軽量版](./2026-10-11-minimal-repository-wide-refactoring.md)に置き換えられた。
以下は当時の提案を保存した履歴であり、旧段階移行を現在の必須範囲にはしない。

## Context

SignKitはコマンド別のポート、DBの原子的公開、Gitと不変オブジェクトを既に持つ。
一方、方針がapplicationとDBアダプターに重複し、runtime・権限・文書処理・UIの操作状態にも責務の混在がある。
ファイルサイズだけを基準に分割しても、同じ判断の複数実装や正本の曖昧さは残る。

## Proposal

モジュラーモノリスを維持し、一つの業務方針に一つの責任者を置く。
最初にreadyの現行契約を固定し、コマンド固有の正規化・receipt・監査、依存の組み立て、権限を縦に移行する。
成功した方法を他のコマンド、文書の正本、durable job、UI/API/CLIへ展開する。
詳細と完了ゲートは [計画](../refactoring-plan.md)、[責務](../refactoring-boundaries.md)、[検証](../refactoring-verification.md) に置く。

## Trade-offs

両DBに必要なSQLの原子性チェックは残るため、すべての重複が消えるわけではない。
それを隠す万能transaction abstractionより、操作固有の公開境界とshared contract testを選ぶ。
旧形式の互換readerも当面残るが、新規書込の設計とは分け、利用確認後に除去する。

監査・receipt・文書バイトを最初は変えないため、段階的な検証と切り戻しが可能になる。
全体rewriteよりPR数は増えうるが、無関係な署名・配信・証拠の変更を同時に持ち込まない。

## Rejected alternatives

- ファイル行数を目標にした分割だけ。
- D1のtriggerをアプリケーションの事前チェックで置き換える。
- microservices、全面event sourcing、汎用Unit of Work、万能command/job framework。
- すべてのactor・status・artifactを一つの巨大な型へ統合する。
- リファクタリングに合わせた既存migrationの書換え・データ初期化。
