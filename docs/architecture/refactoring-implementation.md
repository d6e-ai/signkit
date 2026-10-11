# 軽量リファクタリングの実施記録

Date: 2026-10-11

Status: merged — #223 → #224 → #225 → #226 の順にマージ済み。リリース・デプロイはこの実施記録とは別の運用作業。

[計画](refactoring-plan.md) の対象一覧に対する、変更と変更しなかった理由の記録。
起点は手元の `189cc55996a041dec9cc89e5bf67648623c8daf8`。未コミットだった計画を先にコミットした。
全ファイルのセキュリティ監査や、未検証のprovider構成の動作保証を意味しない。

## PRスタック

| 順序                                                   | 内容                                            | 差分の責任者                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [1 / #223](https://github.com/d6e-ai/signkit/pull/223) | ready/sign/approveの純粋な操作契約と共通routing | `domain/commands/`。DB固有のrow mappingと原子的公開は各Storeに残す                                                              |
| [2 / #224](https://github.com/d6e-ai/signkit/pull/224) | PostgreSQL poolとcommit-pinned文書依存の入口    | `application/runtime/`。機能別runtimeが操作固有のサービスを組み立てる                                                           |
| [3 / #225](https://github.com/d6e-ai/signkit/pull/225) | bounded streamとcapped backoffの小さな共通処理  | `ports/bounded-object-stream.ts` と `ports/capped-exponential-backoff.ts`。上限・エラー・cancel reason・job状態は呼出し元が所有 |
| [4 / #226](https://github.com/d6e-ai/signkit/pull/226) | UI/API/CLIと仕上げ                              | `client/http-problem.ts` とrecipientの通信/receipt検証。操作状態と曖昧な結果の分類は各callerが所有                              |

後続PRのbaseはレビュー中は直前のブランチとし、先行PRのマージ後に `main` へ変更して1 → 2 → 3 → 4の順にマージした。
DB schema、SQL/bind/trigger/lock順、公開API、監査hash version、Git・PDFの保存形式は変更していない。

## 全体の点検結果

| 計画の対象                                   | 点検した根拠と対応                                                                                                                                                             | 今回残した責務・理由                                                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 下書き・PDF/DOCX・文書順序                   | `draft-persistence.ts`、`docx-conversion-service.ts`、`sent-document-pdf.ts`、`uploaded-pdf-upload-service.ts` の同じchunk readerを抽出。PDF previewのDOCX runtime借用を除去   | Git revision、ordered manifest、原本PDF、文書順序は現行通り。DOCX変換は既存のcommitとdurable jobを使い、DOCX bytesをGitへ追加しない                                                                          |
| ready・配置・send・void・expiry              | readyのcanonical request/audit/receiptをappと両DBで共有。`fields.ts`、`send.ts`、`void.ts`、`envelope-expiry-service.ts` も入力・監査・Store境界を点検                         | fieldsのgeometry/field generation、sendの文書セット・delivery予約、voidの失効、expiryのsystem/drainは別の意味を持つ。汎用fingerprintやcommand runnerへ統合しない                                             |
| 閲覧・再発行・署名・承認・辞退               | sign/approveの操作契約と次group/全体完了の判断を共有。`recipient-viewed.ts`、`recipient-declined.ts`、`recipient-capability-reissue.ts` の固有payload・失効条件を点検          | viewedのcontinuation、declineの失効、reissueの新capabilityはsign/approveと同じ判断ではない。署名値、role、field generation、明示的同意、cookieは分離を維持                                                   |
| 完了証跡・PDF・instance seal                 | completionのbackoffとraw SQL依存を整理。`exact-object-stream.ts`、`executed-pdf-assembly.ts`、`pdf-seal-service.ts`、`pdf-seal-job-store.ts` を点検                            | exact-size readerは一つのattested bufferへ直接格納し、bounded chunk readerと異なる。immutable putのhead/get順・missing/mismatched分類も異なる。完了anchor、原子的公開、legacy repair、seal layerは変更しない |
| メール・招待・DOCX job・webhook・maintenance | 共通のbackoff算術を共有し、raw SQLの機能借用を除去。`mail-runtime.ts`、`scheduled-maintenance.ts`、`orphan-collector.ts`、完了access再発行の境界を点検                         | 個別lease/state/attempt、PDF依存待ち、8キューの観測、外部送信、bind/retire、checkpointは残す。sealのstrict retry入力と1時間capはclamp型jobとは異なる。SMTP/Cloudflare Emailの独立選択を維持                  |
| メンバー・APIキー・連絡先                    | `instance-service.ts`、`instance-invitation-service.ts`、`api-key-authentication.ts`、`api-key-service.ts`、`contact-service.ts` と共通HTTP認可入口を点検。raw SQL借用のみ変更 | 既存のinstance canonical JSONと連絡先のrecipient identityは共有済み。active owner/scope、個人連絡先、表示プロフィールと認可の分離を維持。d6e organizationを追加しない                                        |
| 送信者/受信者UI・HTTP/OpenAPI・Rust CLI      | 3つの送信者clientのproblem/JSON transport、4つのrecipient操作のrequest、3つのexact receipt検証、Rustのproblem解析を共有。共通wire fixtureと既存HTTP/OpenAPI/schema driftも確認 | 各Error subclass、browserのbounded fallback、CLIのextension/UTF-8/title方針、consent、body/keyの曖昧な再送、cookie、strict mutationとforward-compatible readを維持                                           |
| ホスト設定・create-signkit                   | `vite.config.ts`、`cloudflare.config.ts`、Worker wrapper、`packages/create-signkit/src/providers/cloudflare/` の設定・責務・アプリ依存を点検                                   | 三つのhost adapterとdeployment CLIはすでに別責務。binding/config/secret/mailの組合せを今回変更しない。cfの現行版で必要なWrangler互換fallbackは残す                                                           |

## 検証の区別

- 固定fixtureでcanonical request、audit JSON、hash、receiptとroutingを確認。過去hash versionのreaderは維持。
- D1 SQLite harnessと実PostgreSQL 18の既存integrationを実行。これらを同じruntimeの証拠として扱わない。
- 実ローカルworkerd D1に対して、readyの再送・改ざん・同時実行・世代/audit競合・途中rollbackと、sign/approveの完了・次group解放・再送・key conflictを確認。この狭いDB検証ではapp/storeはNode側からD1を呼ぶ。
- 別のruntime smokeでは製品のresolver/handler/jobを実workerd内で実行し、D1/R2の下書きGit archive、固定revisionのPDF pages/bytes、durable DOCX exportとhash検証済みbytesを確認。同じ対象を実Node/PostgreSQL/S3でも確認。
- 既存の実Node/PostgreSQL/S3/Rust CLI E2Eで送信者操作、受信者の署名・承認、完了PDF・証跡を確認。OAuthと外部メール配送はこのE2Eの対象ではない。
- stream overflowのcancel reason、cancel/read例外、error生成順、lock解放、nonzero-offset viewを固定。共有計算の抽出でI/O回数やbuffer保持方式を変更していない。

使用したDB・object store・callerは破棄可能なローカルの合成fixture。実インスタンスの情報やcredentialは含まない。

## 最終チェック

| 検証                        | 結果                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server + 実PostgreSQL 18    | 352ファイル / 4464テスト成功。PostgreSQL projectのskipなし                                                                                                                   |
| 実Chromium browser          | 23ファイル / 176テスト成功                                                                                                                                                   |
| 変更対象UI/client/OpenAPI   | 20ファイル / 236テスト成功。HTTP/route parityとmutation schema driftは全体suiteでも確認                                                                                      |
| Rust CLI                    | 全suite成功。共通wire fixture、部分problem、caller別fallback title、500-byte UTF-8境界を追加。fmtとall-target clippy (warnings denied) 成功                                  |
| Svelte                      | check: 0 errors / 0 warnings。公式autofixer: issues/suggestionsなし                                                                                                          |
| Node adapter                | buildと既存node-build検査成功。更新したRust binaryでrecipient E2Eも成功                                                                                                      |
| Cloudflare / Vercel adapter | build成功。Cloudflareのbuild-output packagingも成功                                                                                                                          |
| create-signkit / cf tooling | 256テスト成功 / 既存1テストskip、tooling 8テスト成功                                                                                                                         |
| lint                        | tracked source/docsのPrettierとESLint成功                                                                                                                                    |
| 独立レビュー                | Grok/Sonnetの実装を親で検証。Claude Opusが4つの差分をread-onlyレビューし、修正必須の問題なし。PR4の権限で読めなかった差分は保存patchを使った同一native sessionの再確認で補完 |

lint対象から無関係な未追跡 `output/`・`tmp/` を除外し、既存のvendored/generated除外も維持する。
レビューはsource比較であり、子エージェントの報告をテスト実行の証拠にはしない。
#223・#224・#225・#226 の最終headは、いずれもCIの全7ジョブ成功を確認した。
Bugbotの自動レビュー本文を確認し、現時点で取得した4本のreviewコメントに指摘はない。

## 残る検証と範囲外

Workers/D1/R2でready → send → recipient decision → completionを通す**製品全体E2E**と、
大容量PDFのWorker CPU/メモリ限界検証は、今回も確認済みへ変更しない。
対象handler/jobのruntime smoke、SQLite harness、adapter buildとは別の証拠が必要。
Vercelは従来通りbuild/CI-onlyで、実運用構成の検証を追加していない。

意味の異なるreader/immutable-write確認やseal retryを残したことは未調査ではなく、今回共通化しない判断。
新しい権限/成果物型体系、汎用job/publisher/DI、全API code generation、renderer・保存方式の変更、
releaseや実インスタンスへのdeploymentは、この軽量リファクタリングへ追加しない。
