# 最小限のリファクタリングの検証

Status: merged and verified — [全体対象の軽量計画](refactoring-plan.md) の検証条件。実行した検証と未充足の範囲は [実施記録](refactoring-implementation.md) に区別して記録する。4本ともマージ済み。

作成日: 2026-10-05。2026-10-11に差分中心のゲートへ再編。調査基準は計画に記した手元のHEAD。

## 1. 既存テストを活かす

全体を点検するが、全機能のテストを新しいframeworkへ移さない。
既存のunit/integration/browser/Rust、route-parity、mutation schema drift、adapter buildを残す。
各PR内で対象の現行出力を先に固定し、欠けたケースだけ補ってから抽出する。
テスト追加だけの全体R0や、readyだけの先行3 PRを必須にしない。

| 変更                                     | 必要な証拠                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| 純粋な正規化・fingerprint・監査・receipt | リファクタリング前の固定入力/バイト、正常・再送・競合・改ざんの同じ結果                |
| DBアダプターから共通契約を利用           | D1と実PostgreSQLの関連spec、row mapping・receipt・部分失敗・同時実行の維持             |
| runtimeの入口/生成を変更                 | 呼出し元の依存検査、設定・遅延生成のテスト、対象handler/jobの実runtime確認             |
| バイト検証・不確実な保存確認             | 実バイト、上限、nonzero-offset view、missing/mismatch/provider failure/曖昧なputの違い |
| backoff等の計算                          | 固定時計、境界値、attempt上限、jitterの範囲、既存lease/stateを変更していない差分確認   |
| UIの通信/receipt/retry                   | browserのpending・曖昧な結果・同じbody/key・明示的同意・cookie副作用                   |
| HTTP/OpenAPI/Rust入力                    | 変更した契約のpositive/negative fixture、既存CLIテストと実サーバーE2E                  |

固定fixtureは合成データを使う。実インスタンスの契約書、ユーザー、credential、account情報を入れない。
期待fingerprint/監査JSON/hash/receiptを実装と同じbuilderで生成して比較するだけにしない。
JSONのkey順や旧receiptのバイト差を新しいsnapshotで隠さない。
既存のSQL/rollbackテストをpure helperテストで置き換えない。

## 2. コマンドと権限の回帰条件

readyで共有する契約は、D1とPostgreSQLで同じ入力と期待値を使う。
setup/row mappingはDB別に残し、全Storeの共通テスト基盤への移行は要求しない。

- 正常publishに状態・全recipient・receipt・監査が揃う。
- 同じキー/正規化入力は、最初に確定したID・時刻・結果を返す。
- 別bodyでのキー再利用、古い世代/状態/audit head、壊れたreceiptは現行と同じ失敗になる。
- 同じキー/別キーの同時実行で勝者一つと矛盾しない結果になり、途中失敗が部分更新を残さない。
- APIキーのagent attributionと省略actorの互換動作を維持する。
- 受信者のrole/capabilityと送信者のlocal membership/API scopeを混同しない。
- 公開レスポンス/監査へ新たな秘密・内部キー・不要な個人情報を追加しない。

sign/approveのrouting抽出では、同じ完全なsnapshotに対する次group/完了/監査の出力を固定する。
viewer/cc/prefill、複数routing order、最後のdecision、field generation、同時decisionを含める。
署名値やrole固有の拒否は各操作に残ることを確認する。
元のDB guard・lock順・triggerを保ち、共通計算が永続化時の再確認の代わりにならないことを確認する。

触っていない操作へ機械的に新しいgoldenやshared store suiteを追加しない。
操作の公開条件・SQL・schemaを変更する必要が見つかったら、軽量範囲から分離する。

## 3. 文書・job・UIの維持条件

対象を抽出する際は、関連する既存fault/barrier/legacy specを回帰ゲートに使う。

- 実バイトのscope/digest/size/manifest照合と、不確実なput後の再読取を省略しない。
- 送信時の原本・固定PDF・文書順序・document-set hash・座標を変えない。
- 完了manifest/PDF/receipt/auditの原子的公開、旧PDF修復の元anchor・旧gzip/Markdown readerを維持する。
- admission/composerの入力/出力・ページ・text/font/image予約・証跡末尾・backstopを維持する。
- #219のbind/retire競合、不可逆ledger、checkpointのbarrier testを残す。
- lease所有・上限到達・未知の中断・一時障害・整合性/容量エラーを区別したままにする。
- PDF待ちで送信attemptを消費せず、失敗件数・滞留・永久失敗の観測を維持する。
- #218の新grant/outbox/receipt/audit、旧grant失効、失敗世代CASと同じキーの再送を維持する。
- GETの状態更新は再処理せず、UIの再送から新しいgrantやjobを自動生成しない。
- 署名/承認/辞退の明示的同意、画像の確定、同じattemptのbody/key、cookieとreceiptを維持する。

計算の共通化では、適用前後の呼出し回数、I/O順序、上限、例外の意味を確認する。
既存のbrowserテストのmockだけで、実際のPDF描画やメール配送を証明したとしない。
Rustのローカルvalidate-onlyは、サーバー側の認可や状態判定を代替しない。
strictなmutation入力と、将来のfieldを許容するread応答も混同しない。

## 4. 実行環境と実経路

基準コミットにはNode/PostgreSQL/S3の実サーバー送信者・受信者CLI E2E
(`scripts/test-cli-recipient-e2e.mjs` とCI job) がある。この経路を再利用し、
同じ目的の新しいtest clientや全providerの組合せ試験を作らない。
既存のローカルworkerdのD1 fault-cut・D1/R2署名asset競合・D1再発行の確認は、
それぞれ狭い検証であり、Workers製品E2Eや負荷試験の証明ではない。

| 差分の種類                                                       | 実経路の条件                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 純粋な計算の抽出、I/O・上限・実行順序不変                        | 固定fixture、関連integrationと既存E2E/CIを維持。無関係な製品負荷試験を追加の前提にしない                                       |
| runtime生成/設定/binding/接続入口の変更                          | 実Nodeと対象のローカルworkerd/D1/R2で、変更したhandler/jobの設定・binding解決・最小操作を確認。buildだけで動作確認済みとしない |
| D1のreceipt/rowを扱う判断の変更                                  | SQLite harnessの関連specに加え、対象D1 batch/trigger/rollback/replayを実workerd上で確認                                        |
| renderer、バッファ保持、I/O回数・順序、公開/ジョブ実行方式の変更 | 今回の範囲外へ分離。対象のWorkers/D1/R2製品経路と、上限付近のCPU/メモリ予算の実証を必須にする                                  |
| provider送信や署名UIの挙動変更                                   | 別の挙動変更として、disposableな配送先/実ブラウザで対象の副作用と成果物を確認                                                  |

Workers/D1/R2のready → send → recipient decision → completionを通す製品E2Eと、
大容量PDFのWorker CPU/メモリ限界検証は、基準時点で未充足のまま残る。
軽量計画の完了を、それらの検証完了や全入力の実行可能性の証明と混同しない。
未充足の項目には根拠・必要な試験・今回の変更との関係を残す。
重い経路を実際に変えるなら、上のゲートを避けるために「helperの抽出」と呼び替えない。

ホスト/DB/storage/mailの全組合せを掛け算しない。
providerの関連契約とsupported compositionのsmoke、代表E2Eを利用する。
Vercelは既存のbuild/CI-onlyの位置付けを維持し、実運用対応を今回の成果に数えない。
live配送、実インスタンス、production deploymentには別の明示的な指示が必要。

## 5. PRごとのゲート

1. 対象機能・確認した重複/依存・維持する出力・今回触らない責務を明記する。
2. 抽出前の固定fixtureと関連回帰テスト、D1/実PostgreSQLの必要なspecを通す。
3. 監査/receipt/文書のバイトと、旧receipt/legacy readerの結果が変わらない。
4. role・actor・scope・consent・cookie、job/GC/再発行の既存競合対策を維持する。
5. 対象のimport/call siteを点検し、新しい逆依存や具体SDKの業務層への漏れがない。
6. 同じ操作を旧/新経路で二重実行しない。不要になった委譲・重複だけを除く。
7. 差分に応じた実経路を確認し、結果をmock/SQLite/build/実runtime/製品E2Eに分けて報告する。
8. 関連テストに加え、既存のcheck/lint、adapter build、CIと独立レビューを確認する。

dependency checkerを新設する場合も、今回整えた入口と新規違反の検出に限定する。
全既存違反のallowlist廃止や、全applicationのplatform非依存化を追加の完了条件にしない。
SQL/schema/API/保存形式の変更は本計画に含まない。必要なら別提案とupgrade検証を用意する。

## 6. 全体の完了と切り戻し

[計画の対象一覧](refactoring-plan.md#2-全体を点検する範囲)の各行に、
根拠、対応済み/変更不要/別課題と残る理由、検証結果を残す。
今回共通化すると選んだ処理の単一責任と、別機能runtimeの借用解消を確認する。
未調査や未検証を完了扱いしない。

既存のschema/保存形式を維持し、切り戻し単位は移行した操作/helper/runtime入口とする。
戻した実装でも確定済みreceiptとオブジェクトが読めることを固定fixtureで確認する。
互換reader・必要なfallback・過去のfixtureは、未使用の根拠なしに削除しない。
計画の合意、差分の検証、マージ、リリース、デプロイは別の状態として扱う。
