# 設計を整えるリファクタリング計画

Status: proposed — 現行仕様ではなく、実装着手前の提案

作成日: 2026-10-05。2026-10-10に基準コミットを更新。

調査基準: 手元の最新ソースコミット `4f9267217bd236e361ba10860e76d6aa001de9b9`。#217 「fix:
recover completion PDFs and enforce safe send limits」マージ後で、GitHub main・root local
HEADと一致する。

この基準には、受信者Rust CLI (送信者キーとは別のcapability bearer + 操作と同時の
`--consent`) 、オフラインの `--validate-only`、Node/PostgreSQL/S3での実サーバー送信者・受信者
CLI E2E (`scripts/test-cli-recipient-e2e.mjs` とそのCI job) 、post-commitで交換する受信者
terminal receipt cookie、任意のinstance PAdES B-B/B-T seal (runtime
provider/validator/job/API/CLI/UI/downloadとdual-validator CI) が既にある。これらを欠落
機能として数えない。PAdES instance sealは証明書に紐づく受信者本人の適格署名ではなく、任意の
instance層シールのままである。Vercelは依然CI-only/実験的。
実Workers/D1/R2でのPRODUCT E2Eと、大きいPDFに対するWorker CPU/メモリの限界検証は、今も
欠けている。SQLite harnessのD1テストは実D1の証明にならない。#217の作業で加えたローカル
workerd上のD1 trigger fault-cut確認は、これより狭い範囲で、PRODUCT E2Eの代わりにならない。

この基準と同じソースの#217最終差分では、統合server + 実PostgreSQL suite、ブラウザsuite、
check/lintをローカルで通し、GitHub CIは全jobとCodeQLがgreenだった。これは今後のPR群のacceptance gate
に、ここでの正確なテスト件数を固定する意味ではない。

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

| 現在の構造                                                                                                                                 | 根拠                                                                                                                                                  | 設計上の改善                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ready` のrequest fingerprintと監査payloadを、アプリケーションと両DBアダプターが別々に再構成する                                           | [ready](../../src/lib/application/envelopes/ready.ts)、両DBの `validStoredReceipt`                                                                    | コマンド固有の正規化・receipt検証を、純粋な一つの契約にする           |
| 署名と承認に、次の順序への解放・全体完了・追加監査の計算が重複する                                                                         | [recipient-signed](../../src/lib/application/signing/recipient-signed.ts)、`recipient-approved.ts`                                                    | 役割固有の判断を残し、共通のルーティング判断に責任者を置く            |
| `EnvelopeRequestActor.actorType` が省略可能で、`user` を既定にする                                                                         | [model](../../src/lib/application/envelopes/model.ts)                                                                                                 | 権限と監査上の行為者を、明示的な型・変換にする                        |
| アプリケーション配下のruntimeがenv、SvelteKitの `App.*`、D1/R2/PostgreSQLの実装を知る。共有DB接続の入口もenvelopes配下                     | [send-runtime](../../src/lib/application/envelopes/send-runtime.ts)、`runtime-postgres.ts`                                                            | プロバイダー選択と依存の組み立てをcomposition rootへ集める            |
| 文書プレビューがDOCX exportのruntimeを借り、公開処理にGit読取・PDF生成・保存の責務が集まる                                                 | [envelope-document-pdf-runtime](../../src/lib/application/documents/envelope-document-pdf-runtime.ts)、`sent-document-pdf.ts`                         | 正本の読取、表現の生成、不変バイトの保存、DB公開を別の責任にする      |
| オブジェクトの保存結果が不明な場合の再読取・ハッシュ検証が、下書きや完了成果物に分散する。orphan collectorには既存ポートとDB実装が同居する | [draft-persistence](../../src/lib/application/drafts/draft-persistence.ts)、`completion-artifact-service.ts`、`orphan-collector.ts`                   | 検証済みバイトと不変保存の契約を揃え、参照調査の既存境界を独立させる  |
| 受信者ページが閲覧・辞退・承認・署名の再試行とreceipt検証をそれぞれ持つ                                                                    | [sign page](../../src/routes/sign/[envelopeId]/+page.svelte)                                                                                          | transportの再試行と操作固有の状態を分ける。署名の明示的意思を維持する |
| HTTPのZod schema、OpenAPI、Rustのrequest型と一部の入力検証が別管理。route-parityはあるが、mutation schema drift専用specはない              | [OpenAPI](../../src/lib/openapi/document.ts)、[CLI入力処理](../../cli/src/commands/envelopes.rs)、`cli/src/commands/recipient.rs`、`cli/src/types.rs` | wire契約の責任者と、言語をまたぐ同じ入出力の適合テストを用意する      |

#217までの作業で、primary manifest+PDFのDB公開の原子化、legacy PDF修復、送信前admissionの
保守的な予約、キュー観測、generation CASによる安全なrequeue、mail送信条件の厳格化など、確認
された不具合とマージ阻害要因への挙動修正は既に本体へ入っている。これらは運用上の修正であり、
本計画のどの段階の完了成果物としても数えない。
残存するふるまい変更は別issueで追跡する：[#218](https://github.com/d6e-ai/signkit/issues/218)
(失効/scrub/revoke済み完了メールの明示的re-issue) 、
[#219](https://github.com/d6e-ai/signkit/issues/219)
(24時間超の未参照uploadに対するasset retentionとGCの競合調整) 。単純な
直前re-checkは競合を縮小するが解消しない。これらにはdeterministicなbarrier fault testを
用意し、挙動保存のextractionへ黙って混ぜない。

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

| 段階 | 内容                           | 完了を判断する成果                                                                                                                                    | 主な依存                                  |
| ---- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| R0   | 現行契約の固定                 | readyの両DB契約テスト、旧receiptのgolden、依存違反の明示的baseline、実Workers/D1/R2のE2E gapの明示                                                    | なし                                      |
| R1   | readyを最初の縦切りにする      | 正規化・receipt・監査生成の単一化、両DBのrow mapping、HTTPまでの同じ結果                                                                              | ready対象のR0だけ                         |
| R2   | composition rootと権限の境界   | readyでcompositionを試し、operator/recipient/systemを明示化、App/env/具体providerへの依存をapplicationから外す                                        | R1                                        |
| R3   | 文書・成果物の正本を早期に固定 | Draft/Sent/Completed/Sealedの検証済み型、検証/不変保存/操作固有DB公開/legacy修復と資源契約。対象のWorkers E2E・CPU/メモリゲート合格。#219は別挙動変更 | R2、成果物/send対象のR0とWorkersゲート    |
| R4   | コマンドとルーティングの抽出   | void → fields → send、view/reissue/expiry、最後にsign/approveの共通ルーティング判断、declineは妥当な範囲で統合                                        | 対象のR0/R2/R3。sendはWorkersゲートも必須 |
| R5   | durable jobの共通契約          | 共通lease/失敗contract、capped backoff、機能別error分類、host非依存job入口。既存の個別observability/requeueを一般化                                   | R2、対象のR3/R4                           |
| R6   | API/UI/CLIの契約と状態         | wire schemaの単一責任、既存recipient CLI/validate-onlyを含むRust適合fixture、受信者controller、送信者read model                                       | R1から着手可能。対象のR3/R4と合流         |
| R7   | 整理を完了する                 | 旧経路・不要fallbackの除去、依存ルールのerror化、upgrade/E2E/仕様の整合                                                                               | R3–R6                                     |

R3をR4より先に置くのは、完了成果物とsealの正本を先に固定しないと、R4のvoid/send/sign/approve
ルーティングや後続のPAdES seal監査が、どのPDF・どの監査範囲を正本とするかで割れるため。
R4は一括で全コマンドを書き換えない。signとapproveは共通ルーティング規則を一緒に扱うが、操作
固有の署名値検証・承認権限は統合しない。declineはvoid/expiryと同じterminal遷移を共有できる
範囲でのみ統合する。
R0ではreadyだけでなく、今回の公開・復旧・送信上限・監視・再処理のfault/golden契約を固定する。
R3の成果には送信admissionと完了composerの共通の資源契約も含める。R5ではleaseだけでなく、
中断上限、失敗分類、依存待ち、世代CAS、件数/滞留観測を検証する。詳細は[検証ゲート](refactoring-verification.md#3-全コマンドへ広げる方法)に置く。

R5・R6は、対象機能の契約が固定できた範囲から並行できる。受信者controllerの抽出はR1の
契約固定後とし、それ以前に並行するのはread modelの設計や現行UIの契約テストにとどめる。

### 最初のPR群の具体的な範囲

1. **PR A — readyの現行契約を固定**: shared store contractとgolden fixtureを追加。実行コード・SQL・schemaは変えない。
2. **PR B — readyの方針を一箇所へ**: canonical request、audit payload、receipt検証をコマンド固有の純粋な契約へ。両DBが同じ契約を使う。DB公開ポートのshapeは維持する。
3. **PR C — readyの依存と権限を明示**: composition入口と明示的なoperator attributionを導入。既存入口は薄い委譲にして、wire契約を変えない。
4. **成果物の早期slice**: 検証済みreader → 不変保存の契約 → 送信admission/完了composerの資源契約を小さく移す。旧形式の読取、保存後のDB公開失敗、元の完了anchorからの修復を先に固定し、操作固有のDB公開ポートは統合しない。

R0は機能ごとに完了させる。成果物のfault/goldenだけのPRはAとは別に先行/並行でき、readyの
DB-onlyな抽出を無関係な製品E2E待ちにしない。ただし成果物/sendの抽出は、対象のR0契約と
Workers実行ゲートが揃うまで完了扱いしない。

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
- legacy修復に使う過去のgzip/Markdown形式を読むgolden/versioned readerを、R3で修復経路を触る前に用意する。
- #218・#219のdeterministic barrier fault testは、対象のPRより先に用意し、挙動保存のextractionとの差分比較に使う。
- 基準コミットはGitHub mainの最新マージ済みHEADと一致する。実装時も手元のHEADと差分を確認し、リモートへの同期を勝手な前提にしない。

## 6. 今回やらないこと

microservices、全面的なevent sourcing、ORMへの置換、汎用Unit of Work、巨大なDI container、全ジョブ共通の万能テーブルは導入しない。

全文書のハッシュ体系・Git保存方式・署名方式の変更、暗号鍵の変更、APIバージョン変更、受信者による明示的同意の省略も、この計画には含めない。
Rustの全面code generationは最初から採用しない。まず共有fixtureで契約のずれを検出する。

未完了の製品課題は別扱いとする。revision/diff APIの拡張、証明書に紐づく受信者本人の適格署名、
Vercelの実運用対応、native Blob、enterprise機能を、既存コードの整理と混ぜない。#218・#219の挙動変更も、本
計画のbehavior-preserving extractionとは別のsliceとして扱う。
将来追加しやすい境界は用意するが、それらの機能の完成を本計画の成果として数えない。
一方、Workers/D1/R2のE2EとWorker CPU/メモリの検証は、対象の成果物/送信経路を移す際の
未充足ゲートとして扱う。既存の静的容量テストだけで実行可能性まで確認済みとはしない。

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
