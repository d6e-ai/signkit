# リファクタリングの検証と移行ゲート

Status: proposed — [計画](refactoring-plan.md) の検証詳細

作成日: 2026-10-05。2026-10-10に[計画](refactoring-plan.md)の基準コミット更新へ合わせて見直した。調査基準は計画に記したローカルソースコミット。

## 1. テストを何の証拠にするか

テスト数ではなく、方針・DBの原子性・wire契約・実際の利用経路のどこを証明するかで分ける。

| 層                              | 証明すること                                                  | fixtureと実装                                                 |
| ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Pure policy                     | 正規化、routing、監査計画、境界値、エラー分類                 | 小さい決定的な入力。時計とIDを注入                            |
| Store contract                  | 同じ入力の結果、receipt、replay、state/audit/outboxの全体整合 | 同じテスト本体をD1/PostgreSQL adapter factoryで実行           |
| Engine / Object / Mail contract | 実バイト、上限、不変保存、配信providerの結果分類              | 既存R2/S3、SMTP/Cloudflareの各実装と適切なfake/test endpoint  |
| HTTP contract                   | 認可、body上限、schema、Problem、公開レスポンス、cookieの作用 | 実handler + 正常/異常fixture。業務判定をfixture側へ複製しない |
| Browser component               | 操作、表示、pending/retry、PDF canvas、dialog、download event | 安定したclient境界をmockし、実ブラウザの挙動を確認            |
| Product E2E                     | sender/recipientの経路がDB・storage・jobへ繋がる              | disposableな実backend。DB値を直接変更して成功扱いしない       |
| Upgrade / release smoke         | 過去状態からの移行、ホスト構成、buildと公開契約               | サポートする前リリースからのfixture、各targetのbuild          |

既存のunit/integration/browser/Rustテストを廃棄して一気に書き直さない。
共有するのは**契約の入力と期待値**。SQL、receipt builder、期待監査payloadをテストへコピーして同じ誤りを再実装しない。

## 2. 最初のready契約

shared contractを、D1のSQLite harnessと実PostgreSQLで同じassertionとして動かす。
さらにD1 runtimeのbatch/trigger挙動はローカルWorkers経路で確認する。SQLite mockだけをD1本体の証明にしない。
#217の作業で、ある一つのjob queueについてローカルworkerd上のD1 triggerをfault-cutする確認が
既に入ったが、対象も操作も狭い。readyの共有契約は、この手法をreadyのD1 batch/trigger全体へ広げる。

最低限、以下を含める。

- 正常publishでは、ready状態、全recipient、command receipt、監査eventが揃う。
- 同じキー・同じ正規化入力は、最初に確定したID・時刻・監査eventのreplayになる。
- 同じキー・別の意味の入力は競合となり、追加行を作らない。
- 古いgeneration、別状態、別audit head、壊れたreceiptでは部分更新を残さない。
- 同じキーの競合と別キーの同時publishでは、勝者一つと矛盾しない敗者結果になる。
- recipient挿入やaudit appendなど途中の失敗を注入しても、公開境界全体がrollbackする。
- 名前・メール・token・内部オブジェクトキーを公開receiptや監査へ追加しない。
- APIキーによる操作はagentとして記録され、キー所有者と監査actorを取り違えない。

golden fixtureはリファクタリング前のコードから作った合成データを固定する。
fingerprint、audit payload JSON、event hash、receiptを正確なバイトで比較し、機械的な「新しいsnapshotに更新」で差異を隠さない。
実インスタンスのユーザー・契約書・credential・account情報は使わない。

## 3. 全コマンドへ広げる方法

テスト本体をDBごとにコピーしない。operationごとの契約を用意し、setup/teardownとrow読取のadapterだけをDB別にする。
失敗時にはoperation・scenario・backend・結果を安全に表示する。

| 操作群                          | 必須の固有シナリオ                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| draft / upload / document order | 原本PDFバイト不変、manifest一致、世代CAS、storage保存後のDB公開失敗、過去revision読取、legacy修復向けの過去gzip/Markdown形式を読むversioned reader   |
| fields / send                   | 文書ごとのpage座標、field generation、ready anchor、送信文書セットと監査・outboxの同時公開                                                           |
| view / reissue                  | capability失効、lineage continuation、別タブcookie競合、配信中lease、未解放groupを解放しない                                                         |
| sign / approve                  | role、明示的意思、必要field、競合、次group解放、最後のdecisionによる完了、監査event順序、署名image再検証後の再描画UX (stale/incompatibleな場合)      |
| decline / void / expiry         | terminal状態、capability停止、outboxの安全な停止、配信中の競合、監査整合                                                                             |
| completion                      | 固定証拠の検証、改ざん/過大サイズ/一時障害の区別、lease喪失、再開、公開receipt、後から追加されたPAdES seal等の監査と組み合わせたPostgreSQL修復テスト |
| invitation / contacts / API key | local membership、ownerスコープ、失効、mail intent、PIIを含まないreceipt・log                                                                        |

Fake storeは純粋なサービス調整のテストに使えるが、rollbackやSQL制約の証明には使わない。
PostgreSQLの共用テストDBによる直列化は当面維持し、専用schema/DBによる隔離を実証してから並列化する。
ブラウザspecのmodule mock共有も同様に、隔離を作る前に並列化しない。

成果物を抽出する前に、R0のfault/golden契約として以下を固定する。

- オブジェクト保存後、manifest/PDF pointer/監査/receiptの各公開途中で停止しても、DBは全体でrollbackする。保存結果不明の再読取と同じreceiptのreplayを含む。
- PDF未公開のlegacy状態から、元の完了anchorとJSON/Markdownのdigestを維持して修復する。後続監査がある場合もD1/実PostgreSQLで確認し、旧gzip/Markdownのgoldenを新しいsnapshotで置き換えない。
- 複数PDFの合計ページ、証跡末尾、入力/出力容量、将来のtext/font/image予約が上限内/外の両方で一致する。拒否は送信PDF・招待の公開より前、完了時のbackstopは維持する。
- 既知の一時障害の上限到達、lease切れ、原因不明の中断、整合性/容量エラーを区別する。中断上限で重い処理を再実行せず、後続の正常jobが進む。
- PDF待ちの完了メールはattemptを消費しない。参照済み署名/initialsは正しいscopeだけで保持する。#218/#219の再発行・削除競合は別の挙動変更のbarrier testにする。
- HTTP 200のbatchでも失敗件数がログに出る。8キューのlifetime/overdueと永久失敗を検知し、不正な集計値を正常と報告しない。
- GETの状態更新は再処理しない。POSTの世代CAS、同じcommandの曖昧な結果からの同じキーでの再送、別世代の新しいキー、公開後のdurable replayをAPIとUIで確認する。

## 4. API・CLI・ブラウザの一致

同じ契約fixtureを、HTTP validator、OpenAPIのschema適合、対応する送信者・受信者Rust CLIのpayload読込・request型へ入力する。
正しい入力だけでなく、unknown key、UUID形式、配列数、string長、整数上限、field generation、recipient roleなどの拒否例を共有する。
JSON Schemaで表せない正規化・role間の意味的条件は、domain側のテストとして区別する。
定数の一致だけでなく、入力のshape・serializationとサーバーの受け付ける/拒否する結果を確認する。
CLIがローカルで検証する範囲とサーバーへ委ねる範囲を明示する。既存の拒否条件を強める変更は、挙動を変えない抽出と分けてレビューする。
既存の`--validate-only`はオフラインのローカル検証であり、サーバーへの実送信を伴わない。契約
fixtureは、ローカル検証で防ぐ範囲とサーバーが最終判定する範囲を別々に確認する。

署名・承認・辞退・閲覧・再発行・contacts・jobのHTTP/OpenAPI契約も対象に広げる。
既存の受信者Rust CLIのローカル検証範囲は、サーバー側の最終判定を代替しない。
public PDFの固定404/503やcookieの副作用は、JSON Problemの一般化に巻き込まず個別に確認する。

既存の送信者・受信者Rust CLIには実サーバーE2E (`scripts/test-cli-recipient-e2e.mjs`とCI job)
がある。既存のwiremockテストはCLIの通信・redirect拒否・secret非表示の検証に残し、この実サー
バーE2Eを実handlerとの結合の証拠として扱う。一つのE2EでOAuth・メール配信まで証明したとしない。

追加する実経路は最小限にする。

1. Node/PostgreSQL/S3: 既存の`scripts/test-cli-recipient-e2e.mjs`が送信者・受信者Rust CLIで
   実サーバーのcreate/commit/ready/send/署名/完了を既に確認している。この経路を各段階の共有
   契約fixtureの実証先として使い、新しいtest clientを重複させない。
2. Workers/D1/R2: 同じ合成契約と既存のHTTP経路で、ready → send → recipient decision →
   completion publicationを通す。実Workers/D1/R2のPRODUCT E2Eは未充足であり、
   ローカルworkerdのD1 fault-cut確認だけでは代用にならない。大きいPDFに対するWorker CPU/
   メモリの限界検証もここに含める。
3. Browser: 日本語PDF、複数文書、配置、署名dialog、完了PDF表示、実download eventを確認する。
4. Mail: disposableなSMTP受信先で本文locale・HTML・完了PDF添付を確認。Cloudflare providerの実配送は認可された検証を別に行う。

このE2Eのためだけに新しい受信者権限種別を追加しない。既存の受信者Rust CLI/cookie経路を通し、
追加機能は別のsliceで扱う。

D1/PostgreSQL × 全storage × 全mail × 全UI/CLIを掛け算しない。
providerはポートの契約とsupported compositionごとのsmoke、DBはshared store contract、利用経路は少数の代表E2Eで検証する。
ただし相互作用が問題になるWorkers上のSMTPなど、既知のruntime固有経路は個別のゲートを持つ。
Vercelは現状のbuild/CI smokeと、別の機能課題である実運用対応を分ける。

R3/R4で成果物・sendを移す前に、Workersの設定上の実行予算を明示し、上限に近い複数PDF、
Unicode text、署名画像、証跡末尾を含む代表ケースのCPU/メモリを実測する。静的容量の合格と
runtimeの合格は別のゲート。予算を満たせず非同期化や許容範囲の変更が必要なら、挙動変更として
別設計にし、抽出に紛れ込ませない。

## 5. 各PRの完了ゲート

1. 対象の責務・不変条件・変えないwire/保存形式をPRに明記する。
2. 対象のpure policy、shared store contract、HTTPと既存UI/CLIの関連テストを通す。
3. fingerprint・監査・receipt・文書バイトのgoldenが意図せず変わっていない。
4. 旧receiptとlegacy読取経路が、新実装でも必要な期間動く。
5. 新しい逆向きimport、暗黙actor、provider固有型が業務層へ増えていない。
6. 一つの操作は旧経路または新経路の片方を使い、二重publishしない。
7. SQLやschemaを変える場合は、freshだけでなくサポート対象の旧状態からupgradeを確認する。
8. 機能移行の完了後に、薄い委譲・不要fallback・旧fixtureを除去し、specを更新する。

依存ルールは最初に既存違反の明示的allowlistを作り、新規違反を拒否する。
全移行が終わった時点でallowlistをなくし、domain/application/portsからenv・HTTP・platform SDK・具体DB/object/mail実装への依存をerrorにする。
pure document engineなど許可する内部境界は明示し、単に別名の `utils` へ違反を隠さない。

## 6. 移行と切り戻し

R0–R3の初期sliceはSQL/migration/保存形式を変えず、旧リリースのreceiptが読める状態で進める。
必要なschema拡張はexpand → reader対応 → writer切替 → 利用確認 → contract、の順に独立して扱う。
既に適用されたD1/PostgreSQL migrationは変更しない。
初期化や実インスタンスの削除をテストの代わりにしない。

切り戻しの単位は移行したoperation。schema/保存形式が同じ段階なら、ひとつ前の実装へ戻しても確定済みreceipt・オブジェクトを読めることを確認する。
format変更後のrollback互換性は、変更前に別の判断として明記する。
機密情報のない失敗コードとoperation/jobのtraceで、新旧の挙動を追えるようにする。

実インスタンスへのデプロイや破壊的変更は、この計画作成には含まない。
実ブラウザでの保存ファイルやメールpreviewなど未確認の受入条件は、HTTP 200やバイト取得だけで完了扱いしない。

## 7. 計画全体の完了条件

- 狙った業務方針の正規化・receipt・監査・routingの実装に、責任者が一つある。
- DBの原子的条件は共有契約に適合し、競合・部分失敗で壊れない。
- applicationをSvelteKit/platform envなしで組み立て、契約テストできる。
- Draft/Sent/Completed/Sealedの参照を区別し、検証済み入力だけから成果物を公開する。
- UI/CLIの操作が同じcommand/queryへ繋がり、署名者の権限・意思を守る。
- durable jobをhost非依存で実行でき、再開・失敗分類・lease喪失を検証できる。
- 旧経路の整理とarchitecture specの更新を終え、提案と現行仕様の違いが明確である。

この文書を置いたことや、ファイルを分け終えたことだけでは、どの条件も達成したと扱わない。
