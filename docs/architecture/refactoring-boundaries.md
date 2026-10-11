# 最小限のリファクタリングで整える責務

Status: merged — [全体対象の軽量計画](refactoring-plan.md) の責務詳細。4本ともマージ済み。具体的な変更と残した責務は [実施記録](refactoring-implementation.md) に置く。

作成日: 2026-10-05。2026-10-11に軽量範囲へ再編。調査基準は計画に記した手元のHEAD。
以下は責務の説明であり、新しいパッケージ・型体系を必須にするものではない。

## 1. 共通化するかを決める

共通化は、現在二箇所以上にあり、同じ入力・出力・副作用・失敗の意味を持つ処理に限る。
似た構文でも、正本、権限、エラー、時刻、上限が異なる処理は別のまま残す。
差を巨大なoptions objectやmode分岐へ押し込まない。

| 責務            | 今回整えること                                                            | 今回変更しないこと                                        |
| --------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| 操作の契約      | 操作別の正規化/入力ハッシュ・監査payload・receipt検証の重複を純粋な契約へ | API/Storeのshape、JSON key順、過去receipt、SQLのガード    |
| ルーティング    | sign/approveの次group・全体完了・追加監査の共通判断                       | role、署名値/field generation、権限、publishの原子性      |
| 依存の組み立て  | 共用DB/ObjectStore/文書engineの入口と別機能runtimeの借用を整理            | providerの選択・設定・既定値、遅延生成、接続の生存期間    |
| 文書・不変保存  | 完全に同じdigest/size検証と不確実な保存の確認を集約                       | 正本・renderer・保存/公開順序・上限・legacy修復           |
| jobの小さな計算 | 同じ意味のcapped backoff等を明示的な引数で共有                            | lease、state、attempt上限、依存待ち、失敗分類、再処理権限 |
| 通信と適合      | 同じキー/bodyの再送とreceipt確認、対象のwire fixture                      | 操作固有のUI状態、cookie、consent、Rustの既存拒否条件     |

純粋な契約はHTTP/env/SQL/SDKを知らない場所へ置き、applicationとDBアダプターから利用する。
rowのsnake_case/camelCaseやtimestamp変換はDBアダプターに残す。
`common` や `utils` という名前へ業務判断を集めただけでは完了にならない。

## 2. runtimeと権限

業務判断は既存のポートを受け取り、実行環境を解釈する入口が具体実装を組み立てる。
今回の主対象は `resolvePostgresSql` をenvelopesのruntimeから借りる構造と、
文書プレビューがDOCX exportのruntimeを借りる構造。呼出し元を点検して最小の共有入口を作る。

- 全runtimeの移動、全サービス共通factory、DI containerを先に作らない。
- ホスト/DB/storage/mailの選択を独立に扱い、既存設定の解釈を変えない。
- providerは必要なものだけ生成する。NodeのDB poolは維持できるが、request/actor/session/bindingをglobal cacheへ混ぜない。
- 業務層・ポートへ `App.Locals`、platform env、具体SDKの依存を増やさない。
- 移した入口の呼出し元と依存方向を検査する。全リポジトリの依存違反をゼロにすることは今回の前提にしない。

本人確認、ローカルメンバーシップ、APIキーのscope/active owner、受信者capability、system入口は既存の境界を維持する。
表示用の名前・メールを認可に利用しない。送信者キーで受信者を代行しない。
bearer失敗時のcookie fallback、署名意思の自動付与、権限再確認の省略を追加しない。

`EnvelopeRequestActor.actorType` の省略をuserへ写す現行互換動作と、APIキーのagent attributionを維持する。
共通化でactorの意味を固定する場合も、既存の入口で同じ値へ変換する。
新しいOperator/Recipient/System型の全面導入や、全呼出しの暗黙既定除去は今回要求しない。

## 3. コマンドとルーティング

`ready` のcanonical request、audit payload、stored receiptの検証を一つの操作固有契約にする。
他の操作は点検で実際に重複しているものだけ対象にする。異なる操作のreceiptを汎用形式へ統合しない。

`EnvelopeReadyStore`、`EnvelopeSendStore`、`RecipientSignStore` などの操作固有ポートを残す。
D1のbatch/triggerとPostgreSQLのtransaction/lock順も残す。
TypeScriptの共通関数ではSQLの原子チェックを置き換えられない。

fingerprint・監査JSONのkey順・hash version・receiptの公開内容を維持する。
再送は最初に確定したID・時刻・結果を返し、現在の規則で作り直さない。
audit head競合、世代競合、別bodyでのキー再利用を、共通の「全部retry」にしない。

sign/approveの共通routing判断は完全なsnapshotから純粋に計算し、
次のaction-bearing groupの解放とenvelope完了、追加監査の順序を返す。
署名値、必要field、署名者/承認者のroleは各操作に残す。
viewer/ccを完了数へ混ぜず、prefillの扱いも変えない。
publish側のsnapshot/世代/audit head再確認と原子的公開はそのまま維持する。
decline/void/expiryまで同じstate machineへ統合しない。

## 4. 文書と成果物

以下の正本は既存仕様として維持する。新しいVerified型の全面導入はしない。

| 段階      | 維持する正本                                                  |
| --------- | ------------------------------------------------------------- |
| Draft     | Git revisionのMarkdownとordered manifest、原本PDFのdigest参照 |
| Sent      | sent commitに結び付いた文書ごとの不変PDFセット                |
| Completed | 固定されたsent文書・field値・decision・完了時点の監査anchor   |
| Sealed    | completed PDFを置き換えない任意のinstance PAdES seal layer    |

共通化できるのは実バイトのdigest/size確認や、不確実なimmutable putの結果を再読取して検証する小さな処理。
scope/manifest/参照の対応、canonical key、旧形式、許容サイズ、エラーの意味は各呼出し元が維持する。
metadataだけの確認に弱めず、保存結果不明の確認を無条件の上書きや自動retryへ変えない。
保存後にDB公開が失敗した場合の未参照オブジェクトと既存GCの扱いを維持する。

原本、文書順序、document-set hash、送信後のPDF、署名座標、完了証跡anchor、seal対象を変えない。
後続監査から完了時の証拠を作り直さない。
renderer、admission/composerの上限・予約、バッファ/I/Oの方式、公開順序、legacy repairは書き換えない。
旧gzip/Markdownや単一PDFのreaderを、未使用と確認せず除去しない。

#219のsignature asset ledgerはpendingからboundまたはretiredへの一方向のまま。
参照確認、bind/retireのDB調整、cleanup checkpointを共通helperの外へ隠して省略しない。
ledgerやorphan collectorの全面的なポート移行は今回の必須範囲ではない。

## 5. jobと配信

共有してよいのは同じ意味のbackoffなどの小さな計算。上限・時刻・jitterの扱いは明示して現行値を保つ。
機能ごとに意味が異なるエラー分類を、一つの汎用分類器へ押し込まない。
必要なsafe codeの対応表を整理しても、公開エラーやretryable判定は変えない。

lease token所有、reclaim、attempt、中断上限、依存待ち、job state/table、scheduler/drainの実行方式は維持する。
メール/DOCX/完了成果物/webhook/sealを共通runnerにしない。
外部メールのexactly-onceをDB receiptから保証したと称さない。
PDF待ちは送信attemptを消費せず、未知の中断を既知の一時障害と推定しない。
8キューの件数・滞留・永久失敗の観測も維持する。

GETは状態取得だけ。requeueは既存の明示的POSTと失敗世代CAS/冪等性キーを維持する。
#218の完了メール再発行は明示的な後続grant/outbox/receipt/auditの発行であり、
古い失効済みgrantや証跡を書き換えない。共通retry helperから自動的に呼ばない。

## 6. UI・API・CLI

受信者ページの通信・同じbody/keyでの再送・receipt確認だけを、操作固有の表示状態から分ける。
bodyが変われば別attempt。同じattemptの曖昧な結果は同じbody/keyで再送する。
署名・承認・辞退は明示的同意を必要とし、controller初期化やpage loadで実行しない。
署名画像は既存の明示的確定操作を維持し、マウス移動のたびに保存しない。

terminal receipt cookie、別タブの新しいcookie、capability失効・lineage、public PDFの404/503は個別に維持する。
画面全体のcontroller/read model化やcomponent分割を目的にしない。

HTTPのZod/OpenAPIとRust CLIは既存のroute-parity/schema driftテストを利用し、
変更した入力/serializationのpositive・negative fixtureだけ補う。
全schema/code generationの導入は要求しない。
Rust CLIは薄いHTTP clientのまま、明示的な型、JSON結果、期待世代、キー、安定したエラーを維持する。
既存のcapability bearerと操作同時のconsent、オフラインvalidate-onlyの限界を変えない。
create-signkitはdeployment/releaseの独立責務として残す。

## 7. 今回の境界整理の完成

選んだ重複判断が一箇所へ集まり、具体的な別機能runtimeの借用が解消され、
新旧の出力・失敗の意味が検証できれば今回の成果とする。
全applicationのplatform非依存化、全actorの型移行、全artifact/jobの再設計は追加条件にしない。
