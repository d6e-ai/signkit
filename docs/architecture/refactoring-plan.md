# 全体を対象にした最小限のリファクタリング計画

Status: merged — 4つの差分は #223 → #224 → #225 → #226 の順にマージ済み。[実施記録](refactoring-implementation.md) に全体の点検結果と検証を置く。

作成日: 2026-10-05。2026-10-11に全体対象の軽量版へ再編。
調査基準: 手元のHEAD `189cc55996a041dec9cc89e5bf67648623c8daf8`。
#217・#219・#218の修正を含む。実装着手時に、その時点の手元の差分を再確認する。

## 1. 方針と工数

**対象はSignKit全体、変更は確認できた重複と不自然な依存に限定する。**
`ready` だけで終わらせず、すべての機能を点検する。ただし、すべてのファイルを変更するわけではない。
現在のモジュラーモノリス、操作固有のStore、文書の正本、更新の原子性を残す。

旧R0〜R7の全面的な境界移行は今回の必須範囲から外す。
新しい型体系や共通基盤の完成を目指さず、同じ判断の複数実装と、別機能のruntimeを借りる構造を減らす。
単なるファイル分割ではなく、変更の責任者と依存の向きを整理する。

目安は**4つのPR群、合計7〜12人日**。既存テストの再利用、必要な回帰テスト、レビュー、文書更新を含む概算であり、
AIの実行時間や納期の保証ではない。新機能、本番デプロイ、大規模な負荷試験基盤の構築は含めない。
PR数は上限ではなく、独立した高リスク変更が残る場合は分割する。

- [今回整える責務と変えない境界](refactoring-boundaries.md)
- [差分に応じた検証と完了条件](refactoring-verification.md)
- [PRスタック・点検結果・検証の実施記録](refactoring-implementation.md)
- [全体対象の軽量版を選ぶADR](decisions/2026-10-11-minimal-repository-wide-refactoring.md)

## 2. 全体を点検する範囲

以下をPR群の担当ごとに点検し、具体的な重複・依存の根拠、対応、変更不要、別課題のいずれかを残す。
未調査を「変更不要」と扱わない。重複を確認できない箇所に、将来のためだけの抽象化を追加しない。

| 対象                                         | 今回の確認・整理                                         | 残す固有の責務                                               |
| -------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| 下書き・PDF/DOCX・文書順序                   | 保存検証の重複、文書プレビューとDOCX runtimeの借用       | 複数文書、原本PDF、Git manifest、DOCXをGitへ入れない仕様     |
| ready・配置・send・void・expiry              | 入力ハッシュ、監査、操作結果の検証の重複を操作単位で集約 | 操作別Store、世代CAS、同期send、SQLの原子的ガード            |
| 閲覧・再発行・署名・承認・辞退               | sign/approveの共通ルーティング判断と通信処理             | role、署名値、明示的同意、capability/cookie、失効条件        |
| 完了証跡・PDF・任意のinstance seal           | 同じ意味のバイト検証・不変保存の小さな処理               | 固定文書・完了監査anchor、描画、公開順序、sealの別layer      |
| メール・招待・DOCX job・webhook・maintenance | 依存の組み立て、同じ意味のbackoff計算・安全な結果分類    | 個別lease/state/attempt、外部送信、復旧・再発行、観測        |
| メンバー・APIキー・連絡先                    | 機能間依存と既存の権限解決の重複を確認                   | インスタンス権限、active owner、個人連絡先、表示と認可の分離 |
| 送信者/受信者UI・HTTP/OpenAPI・Rust CLI      | 通信/retry/receiptの重複、変更対象の契約fixture          | UIの操作状態、cookie副作用、CLIのcapability/consent          |
| ホスト設定・create-signkit                   | 共有runtimeの入口と呼出し元を確認                        | ホスト/DB/storage/mailの独立選択、deployment CLIの独立責務   |

すでに根拠がある入口は、`ready.ts` と両DBの `validStoredReceipt`、
`recipient-signed.ts` / `recipient-approved.ts`、
`runtime-postgres.ts`、`envelope-document-pdf-runtime.ts`、
`draft-persistence.ts` / `completion-artifact-service.ts`、
受信者ページ、既存のroute-parity/mutation schema drift spec。
これ以外は点検結果で必要性を判断し、全コマンドの機械的な書換えを前提にしない。

## 3. 4つのPR群

各PRで、対象の現行出力と固有の不変条件を先にテストへ固定してから抽出する。
テスト追加だけの巨大な前提PRや、ready専用の3 PRを全体の必須入口にはしない。

| PR群                         | 内容                                                                                                                          | 完了条件                                                                                                       | 概算     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| 1. コマンドの重複判断        | readyを含む確認済みのfingerprint・監査payload・receipt検証を操作別の純粋な契約へ。sign/approveの共通routing判断を抽出         | アプリケーションと両DBが同じ判断を使い、旧receipt・監査バイト・競合結果を維持。役割固有の判断は別のまま        | 2〜3人日 |
| 2. runtimeの依存整理         | 共用DB/ObjectStore/文書engineの組み立て入口を整理し、別機能のruntimeを借りる依存を解消                                        | provider選択と設定解釈を維持し、業務判断へenv/具体SDKの依存を増やさない。関係するhandler/jobを実runtimeで確認  | 1〜2人日 |
| 3. 文書・jobの小さな共通処理 | 完全に同じ意味のdigest/size検証、不確実な不変保存の確認、backoff計算を必要な範囲だけ集約                                      | 実バイトの検証、上限、エラーの意味、呼出し順序・回数を維持。DB公開・lease・job state・GC競合の契約を変更しない | 2〜4人日 |
| 4. UI/API/CLIと仕上げ        | 操作固有の状態を残して通信/同じキーでのretry/receipt確認を整理。変更対象の既存契約fixtureを補強し、残った不要経路と仕様を整理 | 明示的同意・cookie・曖昧な結果からの再送を維持。対象のHTTP/OpenAPI/Rustの一致、全体の点検結果、回帰検証が揃う  | 2〜3人日 |

PR 2・3は所有ファイルが独立する部分から並行可能。PR 4のreceipt関連はPR 1で固定した契約に合わせる。
各PR群は複数の小さなcommitに分けられる。独立した処理を無理に一つのレビューへ詰め込まない。

## 4. 変えないもの

- 1データベース = 1 SignKitインスタンス。PostgreSQLとD1は選択肢であり、同時使用を要求しない。
- d6e-authは本人確認、権限はSignKitのローカルメンバーシップ。d6e organizationを持ち込まない。
- 送信者APIキー・受信者capability・system入口の権限分離と現在の再確認タイミング。
- 現行のactor attributionと省略入力の互換動作。全呼出しへの新しい権限型の移行は要求しない。
- APIレスポンス、拒否条件、DB schema/SQL/trigger/lock順、監査hash version、receiptのバイト。
- 文書順序、document-set hash、Git archive/manifest、原本PDF、送信時の固定PDF、完了証跡anchor。
- PDF描画、公開順序、legacy repair、instance seal、送信admission/生成上限と既存のbackstop。
- 操作別Store、lease所有、job state/attempt、失敗分類、依存待ち、明示的requeue。
- SMTP/Cloudflare Emailの独立選択とprovider固有の意味。外部送信をDB transactionへ入れない。
- #218の明示的な後続grant/outbox発行、#219のpending → boundまたはretiredの不可逆性。
- sidebar、container、h-16 header、localeなどのUI方針。UI刷新は含めない。

現行の安全性に問題が見つかれば、根拠を残して別の挙動修正として扱う。
リファクタリングに隠して認可を強めたり、retryを増やしたり、保存形式を変更したりしない。

## 5. 今回は導入しないもの

- Operator/Recipient/Systemの新しい権限型体系の全面導入。
- Draft/Sent/Completed/Sealedの新しい検証済み型の全面導入。
- 汎用command/publisher、共通job runner/table、DI container、Unit of Work。
- 全APIの単一schema化、Rust code generation、送信者read modelの全面再設計。
- 大規模なディレクトリ再編、全runtimeの一括移動、全テストの書き直し。
- ORM変更、microservices、event sourcing、保存方式・署名方式の変更。
- 新機能、実インスタンスの変更、release、deployment。

既存の型・ポート・テストを活かし、必要な小さな関数と明示的な入口だけを追加する。
旧readerや互換fallbackは、使用状況を確認せず削除しない。

## 6. 検証と打ち切りの境界

既存のunit/integration/browser/Rust・OpenAPI・adapter buildを維持し、変更対象の不足だけ補う。
過去receiptの再送、同時実行、部分失敗、監査バイト、文書バイト、署名の明示的意思を確認する。
D1のSQLite harnessと実Workers/D1の検証は区別し、テスト件数だけで成功を判断しない。

実Workers/D1/R2の製品E2Eと大容量PDFのCPU/メモリ検証は、基準コミット時点で未充足。
今回の軽量化で「確認済み」へ変更しない。
純粋な計算の抽出だけなら、未充足の全体負荷試験を全PRの前提にしない。
runtimeの組み立て変更には、対象の実workerd/D1/R2経路の確認を要求する。
I/O、バッファ保持、描画、公開/実行順序を変える必要が生じた場合は、軽量範囲の外へ分離し、
対象のWorkers製品E2E・CPU/メモリ検証を満たすまで、その変更を完了扱いしない。
詳細は[検証ゲート](refactoring-verification.md#4-実行環境と実経路)に置く。

新しい共通基盤や挙動変更が必要になった箇所を、この工数へ無理に押し込まない。
根拠と未解消の課題を記録し、今回触らない理由を明示する。

## 7. 今回の完了条件

- 対象一覧の各機能に、調査根拠と対応/変更不要/別課題の判断がある。
- 今回選んだ重複判断の責任者が一つになり、無関係な機能のruntimeへの借用が解消される。
- 操作別のDB原子性、権限、監査・receipt・文書バイト、jobの復旧条件を維持する。
- 変更したUI/API/CLI経路と実runtimeを、差分に応じたテストで確認する。
- 同じ操作を旧経路と新経路で二重実行せず、今回不要になった委譲・重複だけを除く。
- 文書を現行実装へ合わせ、未確認の実行環境・負荷検証と別課題を明示する。

これが今回の完了であり、旧R0〜R7や理想的な全境界の実現を追加の完了条件にしない。
