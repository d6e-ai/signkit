# 運用修正後の基準再設定と段階の入れ替え

Date: 2026-10-10

Status: proposed — 実装の採用決定ではない

計画範囲は[2026-10-11の全体対象・軽量版](./2026-10-11-minimal-repository-wide-refactoring.md)に置き換えられた。
以下のR0〜R7と当時の基準コミットは履歴であり、現在の実施範囲は最新の計画に従う。

## Context

[2026-10-05の設計優先リファクタリング](./2026-10-05-design-first-refactoring.md) 以降、確認
された不具合とマージ阻害要因への挙動修正 (primary manifest+PDFのDB公開の原子化、legacy PDF
修復、送信前admissionの保守的な予約、キュー観測、generation CASによる安全なrequeue、mail送信
条件の厳格化) が #217 でマージされ、local HEADはGitHub mainと一致する
`4f9267217bd236e361ba10860e76d6aa001de9b9` になった。
旧計画が記録した基準コミット (`d651ccefe31c16dac4907b813d300f859561178b` /
`ef72e80` 由来の未コミット修正) はすでに本体へ統合され、古い。
この間に受信者Rust CLI (capability bearer + `--consent`) 、`--validate-only`、実サーバー
送信者・受信者CLI E2E、terminal receipt cookie、instance PAdES B-B/B-T sealも本体へ入った。
計画3文書がこれらを「まだない機能」として扱っていたため、現状と食い違っていた。

## Proposal

[計画](../refactoring-plan.md)・[責務](../refactoring-boundaries.md)・
[検証](../refactoring-verification.md) の基準コミット記述を `4f9267217bd236e361ba10860e76d6aa001de9b9`
へ更新し、上記の既存機能を欠落機能として数えない。
ready縦切りと段階移行の結論は維持する。R0のfault/goldenとR5の失敗・依存・観測契約を具体化し、R3 (文書・成果物の正本の固定、Sealedを含む
検証済み型) とR4 (void/send/sign/approveのコマンド・ルーティング抽出) の順序を入れ替える。
完了成果物とsealの正本を先に固定しないと、ルーティング判断と後続のPAdES seal監査がどのPDF・
どの監査範囲を正本とするかで割れるため、R3を早期の段階として扱う。
残存するふるまい変更 (#218の明示的re-issue、#219のasset retention/GC競合) は本計画の
behavior-preserving extractionとは別のsliceとして明示し、deterministicなbarrier fault test
を個別に優先する。
sendは不変PDFを先に保存する同期コマンドのまま、操作固有のDB公開境界を維持する。
Workers/D1/R2 E2Eと大容量時の実行予算を対象移行の検証ゲートにし、未確認のruntime適合を
静的な容量上限やSQLiteテストから推定しない。

## Trade-offs

基準の再設定は計画文書の大部分を書き換えるが、実装コードやSQLには触れない。ドキュメントのみの
変更にとどめることで、挙動修正のレビューと設計レビューを混在させない。
R3/R4の入れ替えは、完了成果物の検証済み型を先に固定する分だけR3のPRが先に増えるが、後段の
ルーティング抽出がseal監査と衝突する手戻りを避けられる。
#217で得たgeneration CAS requeueやqueue lag観測を「既存の個別実装」として明示したことで、R5は
新規発明ではなく既存パターンの一般化だと説明しやすくなるが、既存実装の挙動を正本として扱う分、
R5のテストはこの実装との差分検出が前提になる。

## Rejected alternatives

- #217の挙動修正を本計画のいずれかの段階の完了成果物として数える。運用修正と設計リファクタリング
  の責任範囲を混同するため採用しない。
- #218・#219を挙動保存のextractionへ黙って混ぜる。挙動変更と構造移行のレビュー観点が異なるため
  別issue・別sliceのまま維持する。
- R3/R4の順序を変えず、ルーティング抽出を先に進める。seal監査が後から正本の定義を揺らすリスクを
  避けるため採用しない。
- 今回の基準再設定を機に、計画のテスト範囲へ具体的なテスト件数を数値目標として書き込む。実行環境
  やCIの変化で数値がすぐに古くなるため採用しない。
