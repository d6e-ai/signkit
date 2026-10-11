# リファクタリング後の責務と契約

Status: proposed — [計画](refactoring-plan.md) の設計詳細

作成日: 2026-10-05。2026-10-10に[計画](refactoring-plan.md)の基準コミット更新へ合わせて見直した。調査基準は計画に記したローカルソースコミット。

以下の型・関数名は提案上の名前であり、実装済みのAPIではない。

## 1. 依存方向とcomposition

```text
SvelteKit HTTP / page load・action / browser client / Rust CLI
                 ↓ 入出力・認証方式の変換
        application command / query
                 ↓ 方針と業務結果
         domain policy / command contract

composition root → applicationへポート実装を渡す
DB / ObjectStore / Mail / PDF・DOCX engine → 各ポートを実装
```

domainはHTTP、cookie、env、SQL、プロバイダーSDKを知らない。
applicationは操作の調整とポート呼出しを持ち、SvelteKitの `App.Locals` や `event.platform` を受け取らない。
ポート型からHTTP層の型を参照しない。HTTPもDBのrowやオブジェクトキーを直接公開しない。

composition rootが設定を検証して、必要な依存だけを遅延生成する。例として `src/lib/server/composition/` を入口にできるが、場所の変更だけでは完了しない。
DB pool、ObjectStore、mail transportを作る責任が機能別runtimeから除かれ、依存が明示的に注入されることが完了条件。

- ホスト、DB、object、mailの設定を別々の選択として扱う。
- 既存設定の解釈とNode/Cloudflareの既定を維持し、設定変更を必須にしない。
- D1 bindingなど実行環境上の制約を、起動・readiness時に検証する。全組合せを動くと称さない。
- Nodeのstatelessな共有DB poolは許容する。request、actor、session、bindingをglobal cacheへ混ぜない。
- `null` 一つで全てを表す代わりに、内部では未設定・不正設定・一時的障害を区別する。公開エラーの詳細漏洩は増やさない。
- `resolvePostgresSql` をenvelopesの機能入口から借りない。PDF読取がDOCX exportの入口を借りることもなくす。

PDF/PNG/DOCXの純粋なアルゴリズムを一つずつinterface化する必要はない。
置換可能な文書engineの入口と、処理上限・メモリ・外部アクセスの境界を定め、applicationにライブラリ固有の木やオブジェクトを広げない。

## 2. 権限と行為者

「誰であるか」「何をしてよいか」「監査には誰の行為として残すか」を分ける。

| 権限               | 作成する境界                                                                  | 操作と監査上の行為者                                                |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| OperatorAuthority  | d6e本人確認 + activeなlocal member、またはlive API key + active owner + scope | sessionならuser、キーならagent。キー所有者とキー自体を区別する      |
| RecipientAuthority | 既存の受信者link/cookieからcapabilityを検証する入口                           | そのenvelope/recipientの閲覧・辞退・承認・署名だけ。監査はrecipient |
| SystemAuthority    | 保護されたmaintenance入口・内部scheduler                                      | 指定されたjob操作だけ。監査はsystem                                 |

`auditActorOf(authority)` のような明示的変換を用意する。移行入口では、現行の省略入力を
`actorType ?? 'user'` と同じuserへ写す互換変換を保ち、既存のAPIキーのagent記録も維持する。
省略入力を新たに拒否したり、監査actorを変更したりしない。既存の全呼出しを明示型へ移し、
同じ入力の監査/receiptが変わらないことを確認してから、core内の暗黙既定を除く。
必要な旧入口の互換変換は残し、attributionを変える判断は別の挙動変更として扱う。
名前・メールなど表示情報を、権限を証明する値として使わない。
連絡先は作成者のuserスコープ、インスタンスメンバー管理はローカル管理権限のまま。

TypeScriptの型だけでは認可にならない。権限は信頼された認可入口で作り、外部入力からcastしない。
既存の操作が再確認するactive状態、所有者、capabilityと、その確認タイミングを維持する。
型を導入するだけで永続化時の再確認が増えたとは扱わない。メンバー失効などへの追加の競合防御が
必要なら、現行契約との差を示す別の挙動変更として設計・検証する。

APIキーのbearerを提示した失敗時にcookieへfallbackしない、管理・受信者経路でキーを使わせない、送信者キーで受信者を代行しない、という既存の制約を維持する。
受信者cookieの拒否レスポンスが別タブの新しい有効cookieを消さない、再発行後のlineage continuation、既存の辞退receipt交換も保持する。
基準コミットには受信者Rust CLI用のcapability bearer入口と、revoke後も読み取れるterminal receipt
cookieの交換が既にある。ここで示すRecipientAuthorityの境界は、その既存経路にも当てはまる。追加の
qualified署名や新しい受信者権限種別は、別の機能設計として扱う。

## 3. コマンドの方針と原子的公開

コマンドごとに `canonicalizeRequest`、fingerprint、監査payload、receipt parser/verifierの責任者を一つにする。
`ready` なら、アプリケーションと両DBアダプターが同じ契約を利用する。
DB rowのsnake_case/camelCaseやtimestamp表現の変換は各アダプターの仕事。

共有化しても `EnvelopeReadyStore`、`EnvelopeSendStore`、`RecipientSignStore` のような操作固有のポートは残す。
`publishAnything()` や、任意SQLを実行する万能repositoryへ統合しない。

```text
認可・入力正規化
       ↓
prepare: 過去receiptのreplay / 現在のstate・generation・audit headを読む
       ↓ readyの場合だけ
操作固有の方針を計画する
       ↓ 必要な操作だけ
不変オブジェクトを保存・検証する
       ↓
publish: 現在の述語を再確認して一度に公開
       ├ state / revision pointer / recipient・field projection
       ├ immutable command receipt
       ├ chained audit event
       └ 必要なdurable delivery intent
```

最後の四つは、その操作に必要な範囲で一つのDB原子境界になる。
D1ではbatchとrollback trigger/publish guard、PostgreSQLでは規定のlock順とtransactionを維持する。
D1のtriggerはTypeScriptの純粋関数を実行できないため、SQLの競合チェックを無理に一本化しない。共有方針との一致を契約テストで保証する。

外部storage/mail providerの呼出しはDB transactionに入れない。
DBの公開に負けた不変オブジェクトは未参照のまま残り、既存の猶予期間・参照確認付きorphan collectionで回収する。
DBとstorageを跨ぐ全体transactionがあるようには見せない。

sendは送信者の同期コマンドであり、不変PDFを保存・検証してから操作固有のStoreで公開する。
DBだけで完結するreadyにも、非同期の完了成果物jobにも合わせない。共有するのは検証・保存の
不変条件であって、汎用publisherや全操作共通のtransactionではない。

`AuditHead` と監査appendの小さな型を共有し、複数イベントの `sequence + 1/+2` とprevious hashを計画する入口を用意できる。
最初は既存の公開commandのフィールドへ変換し、全StoreのshapeやSQLを一度に変えない。
監査payloadのcanonicalバイト、hash version、receipt formatを変える場合は別のバージョン付き設計が必要。

再試行は共通の「全部retry」ではない。
audit headだけの競合で操作を安全に再計画できるケースと、generation、field generation、状態、キー再利用、配信中leaseの競合を分ける。
公開済みreceiptの再送は同じ結果を返し、操作の意味が変わるretryでは新しい明示的操作を要求する。

## 4. 状態とルーティングの判断

envelope、recipient、delivery、artifact jobのstatusを一つの巨大なstate machineへ統合しない。
それぞれ別の事実であり、`sent` は配信意図の確定、provider acceptanceや受信者の操作完了ではない。

署名と承認の共通部分は `decideRoutingAfterAction(snapshot)` のような純粋な判断にする。
残りのaction-bearing recipient、現在のグループ、次のorderから、継続・次グループ解放・envelope完了を返す。
viewer/ccは署名・承認の完了数へ混ぜない。prefillの扱いも現行契約を維持する。

署名値の妥当性とfield generationは署名操作、承認者のroleは承認操作が担当する。
共有方針の入力は型だけでなくDBで読み取った完全なsnapshotで検証し、古い計算結果のままpublishしない。
capabilityの解放と再発行、辞退・voidと配信中leaseの競合は、既存の原子境界に残す。

## 5. 文書の正本と派生成果物

| 段階      | 正本                                                                          | 読取・派生の責任                                                                                                                         |
| --------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Draft     | 一つのGit revisionのMarkdown + ordered document manifest、PDF原本のdigest参照 | 検証済みrevision reader。DOCX export・配置プレビューはここから                                                                           |
| Sent      | `sent_commit_sha` に結び付いた文書ごとの不変PDFセット                         | 固定pointer、文書ID、digest、size、page情報を検証して取得                                                                                |
| Completed | 固定されたsent文書・field値・受信者decision・完了時点までの監査証跡           | 証跡snapshotを検証し、署名を印字したPDFとmanifestを生成                                                                                  |
| Sealed    | 任意のinstance PAdES B-B/B-T seal (completed PDFへの追加layer)                | seal対象のcompleted PDF digestを検証してから実行し、B-TのRFC 3161 trust chainを検証して取得。seal済みバイトはcompleted PDFを置き換えない |

PDFシールは基準コミットで任意のinstance seal (B-B/B-T、外部key custody、RFC 3161、CIの
dual-validator適合) として実装済み。証明書に紐づく受信者本人の適格署名ではない。sealは
Evidence/Artifactsの後段で、Completedを置き換えずSealedとして積む。

完了後の成果物公開の監査と、署名完了を証明する監査範囲は区別する。
完了証跡の境界は、そのenvelopeの完了decisionに固定し、後続jobの監査を追加するたびに署名時の証拠を書き換えない。
sealの発行とvalidatorの再確認もこの後続jobに含め、完了時点の証跡を書き換えない。

`VerifiedDraftRevision`、`VerifiedSentDocumentSet`、`VerifiedCompletionEvidence`、`VerifiedSealedPdf` のように、参照を受け取っただけの値と実バイトを検証した値を区別する。
これは既存の検証手順を明示するためで、型名を付ければ検証を省けるという意味ではない。

- readerはscope、revision/pointer、SHA-256、size、Git tree、manifestとの対応を確認する。
- rendererは検証済み入力からバイトを作る。SQLやsessionを読まない。
- immutable writerは不確実な保存を再読取し、実バイトのdigest/sizeを検証する。metadataだけで成功扱いしない。
- publisherはバイトの永続化を確認したlocatorだけをDBへ公開する。
- public queryは内部キーを返さず、操作主体ごとの読取権限を維持する。

送信後の表示は保存されたsent PDF、完了後は保存されたcompleted PDFを読む。
現在のrendererで作り直したPDFを、過去に相手が見た文書の代わりにしない。
複数PDF/Markdown、文書順序、原本バイト、document-set hash、座標の基準を変えない。

送信前のadmissionと完了時のcomposerは、ページ・入力/出力バイト・オブジェクト・描画・PNGの
上限と予約を同じ契約で扱う。証跡の末尾ページ、将来の署名値/画像/フォントも含める。抽出で
許容入力や生成バイトを変えず、既存の完了時backstopも残す。Worker上のCPU/メモリで実行できる
範囲は、静的なページ数/容量の上限とは別に実測して確定する。

既存の `OrphanReferenceStore` とcheckpointの境界を独立したポートにし、同じファイルにあるDB実装をアダプターへ移す。
どのjob・receipt・artifactがstorageを保持するかを明示し、削除候補の判定とDB実装を分ける。
24時間超の未参照uploadに対するretentionとGCの競合 (#219) は、この境界を使う別のbehavior
sliceとして扱い、即時recheckで競合を縮小しても解消しないことを前提に、deterministicな
barrier fault testで検証する。

## 6. durable jobと操作経路

共通化するのはlease tokenによる所有、期限後のreclaim、capped backoff、item単位の失敗隔離、時刻注入、safe error codeの扱い。
attempt上限やlease長、terminal/integrityの分類はjob固有の方針として残す。

完了成果物とPDF修復のrequeueには、`expectedFailedAt`/`expectedAttempts`による失敗世代の
CASとdurable receiptが既にある。結果が不明な同一commandは同じbodyと冪等性キーで再送し、
別の失敗世代を観測したら新しいキーを使う。GETは状態取得だけ、requeueは明示的なPOSTだけ。
この再処理権限を、契約を定めず他のjobへ自動的に広げない。

現行のhealth queryは8キューを観測し、作成時刻からの滞留とavailable_atからの遅延を分ける。
batchの失敗件数・処理時間、lease再取得、既知の一時障害、整合性/容量エラー、原因不明の中断を
別の事実として扱う。原因不明の中断を一時障害と推定して無限再試行しない。
完了メールはPDF待ちを送信試行に数えない。#218の失効済みメールの再発行は別の明示的操作。

メール、DOCX、完了成果物、webhookを同じstateやtableへ統合しない。
既存のPDFシールの多段階jobも、単純な配信jobのstateに無理に合わせない。
at-least-onceを前提とし、DB receiptの冪等性が外部メールのexactly-onceを保証すると称さない。

post-completionのdiscovery scanは、取りこぼしから復旧できる既存の利点がある。
負荷や遅延が測定されるまで、全てを完了transaction内のoutboxへ移す変更はしない。
host schedulerと保護されたHTTP drainは、同じapplication job入口の別の呼出し方式とする。Cloudflare内部HTTP dispatchは段階的に置き換えられるが、安全な認可・観測・実行予算が同等であることを条件にする。

## 7. UI・API・CLI

wire contractはHTTP入出力の責任として一箇所で定義し、OpenAPIとブラウザの検証に使う。
domain policyにはHTTP schemaや表示文言を持ち込まない。
既存の送信者・受信者Rust CLIは同じpositive/negative fixtureで適合を検証し、strictなmutation入力と将来のフィールドを許すread応答を混同しない。

受信者clientは、通信・同じキーでの再試行・receipt検証の共通部分と、閲覧/辞退/承認/署名の固有状態を分ける。
署名対象とvaluesを確定した一つのattemptは、同じbodyとキーで再試行する。bodyを変える場合は別attempt。
署名・承認・辞退の明示的同意を、controller初期化や画面load時の自動操作にしない。
閲覧記録の自動化とは別の操作である。

送信者ページは、文書の正本・受信者・配置・配信・完了成果物をquery側のread modelで受け取り、表示状態を管理する。
独自の業務判定をページにコピーしない。利用可能な操作や拒否理由をread modelで示しても、commandは最新状態で改めて判定する。
大きいページは、この責務を取り出した後で必要なUI componentへ分ける。
container、sidebar、h-16 header、breadcrumb、shadcn Field/Select、localeの既存方針を変えるUI刷新は含めない。

Rust CLIは薄いHTTP clientのまま、JSON結果、期待世代、冪等性キー、安定したエラーを維持する。
既存のpayload読込とrequest型の責任を整理し、公開commandを増やさずに契約テストできるようにする。型は明示し、過度なgeneric frameworkで型推論と実装を重くしない。
オフラインの`--validate-only`はローカルの契約チェックに留め、サーバー判定の代わりにしない。
既存の受信者Rust CLIは送信者キーを流用せず、capability bearerと操作に同時の明示的consentを
要求する。この権限分離を維持し、新しい受信者操作を追加する場合も同じ境界を使う。
create-signkitはdeployment/release用の別の責務として残し、通常の契約操作へCloudflare設定を流し込まない。
