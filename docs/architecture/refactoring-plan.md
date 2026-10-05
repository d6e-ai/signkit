# 設計を整えるリファクタリング計画

Status: proposed — 現行仕様ではなく、実装着手前の提案

作成日: 2026-10-05

調査基準: 手元の最新ソースコミット `d651ccefe31c16dac4907b813d300f859561178b`。
`ef72e80` / package version 0.1.4に、未コミットだったD1のbind数修正・SQLite integrationテスト・PDF canvasの初期描画修正をコミットした状態。
GitHub mainへpull/rebaseしていない。リモート側の新しい機能を実装済みと見なさない。

基準コミットを確定する際、関連DBテスト29件、PDFブラウザテスト2件、対象ファイルのformat checkを通した。
全体テスト、PostgreSQL、実D1、実インスタンスの検証を実施したという意味ではない。

## 結論

SignKitを別のアーキテクチャに作り直す必要はない。現在のモジュラーモノリスと、コマンド単位の永続化境界を活かす。

改善の中心は、**一つの判断に一つの責任者を置き、実行環境・権限・文書の正本・更新の原子性を明確にすること**。
ファイルが短くなることは結果であって、目的ではない。

最初は `ready` コマンドを縦に整える。入力の正規化から、冪等性、受信者の確定、監査、D1/PostgreSQLでの公開までを一単位として移行する。
この一例で設計と移行方法を検証してから、他のコマンドへ広げる。

- [責務・状態・権限・公開境界の詳細](refactoring-boundaries.md)
- [テスト設計・移行・完了条件](refactoring-verification.md)
- [提案の理由と採用しない方針](decisions/2026-10-05-design-first-refactoring.md)

## 1. 残すもの

- 1データベース = 1 SignKitインスタンス。d6e organizationを持ち込まない。
- d6e-authは本人確認、SignKitのローカルメンバーシップはインスタンス権限。
- 送信者のAPIキーと受信者の署名権限は別物。
- 1エンベロープに、複数文書、一つの受信者グラフ、一つのGit履歴。
- PDF原本はObjectStore、GitにはMarkdownと文書セットmanifest。DOCXバイトはGitに入れない。
- コマンド固有のStoreポート、D1のbatch/trigger、PostgreSQLのtransaction/lock。
- 送信時のPDF固定、完了証跡の検証、不変オブジェクト。
- SMTPとCloudflare Emailの選択をホスト種別から分離する、既存の対応。
- 受信者のcookie経路と送信者CLIのAPIキーを分離する、既存の権限境界。

これらはリファクタリングの前提であり、簡略化のために削らない。

## 2. 現在の構造で確認できた問題

実害を再現した不具合の一覧ではなく、変更が複数箇所へ波及する構造の一覧。

| 現在の構造                                                                                                                                 | 根拠                                                                                                                                | 設計上の改善                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ready` のrequest fingerprintと監査payloadを、アプリケーションと両DBアダプターが別々に再構成する                                           | [ready](../../src/lib/application/envelopes/ready.ts)、両DBの `validStoredReceipt`                                                  | コマンド固有の正規化・receipt検証を、純粋な一つの契約にする           |
| 署名と承認に、次の順序への解放・全体完了・追加監査の計算が重複する                                                                         | [recipient-signed](../../src/lib/application/signing/recipient-signed.ts)、`recipient-approved.ts`                                  | 役割固有の判断を残し、共通のルーティング判断に責任者を置く            |
| `EnvelopeRequestActor.actorType` が省略可能で、`user` を既定にする                                                                         | [model](../../src/lib/application/envelopes/model.ts)                                                                               | 権限と監査上の行為者を、明示的な型・変換にする                        |
| アプリケーション配下のruntimeがenv、SvelteKitの `App.*`、D1/R2/PostgreSQLの実装を知る。共有DB接続の入口もenvelopes配下                     | [send-runtime](../../src/lib/application/envelopes/send-runtime.ts)、`runtime-postgres.ts`                                          | プロバイダー選択と依存の組み立てをcomposition rootへ集める            |
| 文書プレビューがDOCX exportのruntimeを借り、公開処理にGit読取・PDF生成・保存の責務が集まる                                                 | [envelope-document-pdf-runtime](../../src/lib/application/documents/envelope-document-pdf-runtime.ts)、`sent-document-pdf.ts`       | 正本の読取、表現の生成、不変バイトの保存、DB公開を別の責任にする      |
| オブジェクトの保存結果が不明な場合の再読取・ハッシュ検証が、下書きや完了成果物に分散する。orphan collectorには既存ポートとDB実装が同居する | [draft-persistence](../../src/lib/application/drafts/draft-persistence.ts)、`completion-artifact-service.ts`、`orphan-collector.ts` | 検証済みバイトと不変保存の契約を揃え、参照調査の既存境界を独立させる  |
| 受信者ページが閲覧・辞退・承認・署名の再試行とreceipt検証をそれぞれ持つ                                                                    | [sign page](../../src/routes/sign/[envelopeId]/+page.svelte)                                                                        | transportの再試行と操作固有の状態を分ける。署名の明示的意思を維持する |
| HTTPのZod schema、OpenAPI、Rustのrequest型と一部の入力検証が別管理。route-parityはあるが、mutation schema drift専用specはない              | [OpenAPI](../../src/lib/openapi/document.ts)、[CLI入力処理](../../cli/src/commands/envelopes.rs)、`cli/src/types.rs`                | wire契約の責任者と、言語をまたぐ同じ入出力の適合テストを用意する      |

基準コミットのRust CLIは送信者操作が対象で、recipient command、validate-only、実サーバーCLI signing E2Eはない。
また、暗号的なPDFシールや完了receiptの新しいsessionはこのソースにない。存在しない実装の整理を、リファクタリングとして数えない。

## 3. 到達したい責務の境界

| 境界                         | 唯一の責任                                          | 持たせないもの                                 |
| ---------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| Instance / Authority         | メンバー、招待、キー、所有者スコープ、権限解決      | d6e organizationによる権限、受信者の代行署名   |
| Authoring / Document Set     | 文書一覧、Markdown編集、PDF原本参照、リビジョン     | メール送信、受信者session、PDFシール           |
| Envelope Workflow            | ready、配置固定、send、void、ルーティング、完了判断 | SDK、HTTPレスポンス、PDF描画                   |
| Recipient Access / Decisions | capability、閲覧、辞退、承認、署名、操作receipt     | 送信者キーによる権限昇格、ローカルメンバー管理 |
| Evidence / Artifacts         | 固定された文書・署名・監査の検証、完了成果物        | 可変の下書きからの署名済みPDF再生成            |
| Delivery / Maintenance       | 永続的な配信意図、lease、再試行、webhook、後続処理  | signingトランザクション内の外部送信            |
| Composition / Transports     | ホスト依存の組み立て、HTTP/cookie/CLIの入出力       | 業務の可否判断、監査payloadの独自再定義        |

これは責任の一覧であり、新しい7パッケージや7サービスを作る指示ではない。
既存のディレクトリを使い、公開する型・操作・依存方向を先に整える。
共有するのはハッシュ、時刻、監査headなど意味が同じ小さな契約だけ。`common` に業務を集めない。

## 4. 実装順序

各段階は独立して検証・レビューできる変更に分ける。PRの単位は責務とリスクで決め、ファイル数では決めない。

| 段階 | 内容                      | 完了を判断する成果                                                                           | 主な依存                            |
| ---- | ------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| R0   | 現行契約の固定            | readyの両DB契約テスト、旧receiptのgolden、依存違反の明示的baseline                           | なし                                |
| R1   | readyを最初の縦切りにする | 正規化・receipt・監査生成の単一化、両DBのrow mapping、HTTPまでの同じ結果                     | R0                                  |
| R2   | runtimeと権限の境界       | readyでcompositionを試し、operator/recipient/systemを明示化して他機能へ移す                  | R1                                  |
| R3   | コマンドと状態判断        | void → fields → send、view/reissue/expiry、最後にsign/approveの共通ルーティング判断とdecline | 対象ごとのR0相当の契約テスト、R1/R2 |
| R4   | 文書の正本と成果物        | Draft/Sent/Completedの読取を明確化し、不変保存・検証・描画を分離                             | R2、対象のR3                        |
| R5   | durable jobの共通契約     | 共通leaseテスト、再試行の仕組み、機能別error分類、hostに依存しないjob入口                    | R2、対象のR4                        |
| R6   | API/UI/CLIの契約と状態    | wire schemaの単一責任、Rust適合fixture、受信者controller、送信者read model                   | R1から着手可能。対象のR3/R4と合流   |
| R7   | 整理を完了する            | 旧経路・不要fallbackの除去、依存ルールのerror化、upgrade/E2E/仕様の整合                      | R3–R6                               |

R3は一括で全コマンドを書き換えない。signとapproveは共通ルーティング規則を一緒に扱うが、操作固有の署名値検証・承認権限は統合しない。
R4–R6も、対象機能の契約が固定できた範囲から並行できる。特に受信者controllerの整理は独立した低リスクsliceとして、readyの契約固定と並行できる。

### 最初のPR群の具体的な範囲

1. **PR A — readyの現行契約を固定**: shared store contractとgolden fixtureを追加。実行コード・SQL・schemaは変えない。
2. **PR B — readyの方針を一箇所へ**: canonical request、audit payload、receipt検証をコマンド固有の純粋な契約へ。両DBが同じ契約を使う。DB公開ポートのshapeは維持する。
3. **PR C — readyの依存と権限を明示**: composition入口と明示的なoperator attributionを導入。既存入口は薄い委譲にして、wire契約を変えない。

ここで、過去receiptのreplay、同時実行の結果、監査バイト、両DBの一致、依存の向きを確認する。
この設計が他の操作にも自然に使えると確認できるまで、汎用command frameworkを作らない。

## 5. 移行方針

- 最初はAPIレスポンス、DB schema、監査hash version、manifest format、保存オブジェクトを変えない。
- 同じ操作で旧実装と新実装を同時実行しない。比較するなら純粋な判断の出力だけ。
- 正規化や監査JSONは意味だけでなくバイト同一性を守る。key順を勝手にsortしない。
- receiptの再利用は過去に確定した結果を返す。現在の規則でID・時刻・PDFを作り直さない。
- DBの原子的チェックは残す。アプリケーションの事前確認で代用しない。
- 認可条件の強化、自動retryの追加、CLIの拒否条件変更は、挙動を保つ抽出と分ける。現行より厳しい規則を黙ってリファクタリングに混ぜない。
- schema変更が本当に必要になった場合だけforward migrationを追加。リリース済みmigrationの書換えやデータ初期化を前提にしない。
- legacy単一PDFなど既存形式の読取は明示的な互換入口に隔離する。利用状況と移行方法を確認せず削除しない。
- 今回コミットした手元の修正を基準に含める。実装時も手元のHEADと差分を確認し、リモートへの同期を勝手な前提にしない。

## 6. 今回やらないこと

microservices、全面的なevent sourcing、ORMへの置換、汎用Unit of Work、巨大なDI container、全ジョブ共通の万能テーブルは導入しない。

全文書のハッシュ体系・Git保存方式・署名方式の変更、暗号鍵の変更、APIバージョン変更、受信者による明示的同意の省略も、この計画には含めない。
Rustの全面code generationは最初から採用しない。まず共有fixtureで契約のずれを検出する。

未完了の製品課題は別扱いとする。recipient CLI、revision/diff APIの拡張、PDFシール、Vercelの実運用対応、native Blob、enterprise機能を、既存コードの整理と混ぜない。
将来追加しやすい境界は用意するが、それらの機能の完成を本計画の成果として数えない。

## 7. 設計の完成をどう測るか

行数やファイル数を目標にしない。

- 一つの業務ルール変更が、一つの方針実装とその契約テストで表現できる。
- 新しいホスト・storage・mail実装の追加が、compositionとアダプターに閉じる。
- 送信者UI・HTTP・CLIで、同じ入力に同じ結果と競合が返る。
- 一つの文書の正本・世代・固定されたPDFを、型と参照元から判別できる。
- 失敗した更新が、状態だけ・監査だけ・配信意図だけを残さない。
- 各機能の修正に、無関係な機能のruntimeやページを読む必要が減る。
- 各段階の完了条件がテストと依存ルールに残り、人の記憶に依存しない。

根拠の収集ではClaude Opusに中核の境界、Claude SonnetにUI・CLI・テストを読み取り専用で確認してもらい、最終的な計画はソースとの再照合を経て整理した。
