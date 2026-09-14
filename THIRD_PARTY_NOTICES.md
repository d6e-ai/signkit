# Third-party notices

## shadcn-svelte

SignKit includes adapted registry source files from
[shadcn-svelte](https://github.com/huntabyte/shadcn-svelte) under the MIT License.

```text
MIT License

Copyright (c) 2023 Hunter Johnston <https://github.com/huntabyte>
Copyright (c) 2023 CokaKoala <https://github.com/adriangonz97>
Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Zen Kaku Gothic New (bundled PDF typeface)

SignKit renders the recipient-facing agreement PDF itself and embeds the glyphs
it needs, so the typeface travels inside the deployment bundle as
`src/lib/adapters/pdf/fonts/document-font.ts` (a gzipped, table-stripped copy of
Zen Kaku Gothic New Regular, base64-encoded). Regenerate it with
`node scripts/build-pdf-font.mjs <path-to-source.ttf>`.

Copyright 2022 The Zen Kaku Gothic Project Authors
(https://github.com/googlefonts/zen-kakugothic), licensed under the SIL Open
Font License, Version 1.1. The full license text ships beside the artifact at
`src/lib/adapters/pdf/fonts/OFL.txt`.

The OFL permits bundling and modification (here: dropping tables the PDF
embedder does not read, and subsetting to the glyphs a given agreement uses).
The font is not sold on its own and retains its Reserved Font Name.

## pdfjs-dist

The sender's field-placement editor and the recipient's signing page render the
agreement to a canvas with [pdf.js](https://github.com/mozilla/pdf.js)
(`pdfjs-dist`), licensed under the Apache License 2.0, Copyright Mozilla
Foundation and contributors. Rendering happens entirely in the browser against a
same-origin, session-authenticated document; pdf.js is never used server-side.

Generated Cloudflare type declarations retain their upstream Apache-2.0 notices
inline. Release artifacts will add a generated dependency notice and SBOM before
the first production release.

## Rust CLI (`signkit`) dependencies

The SignKit Rust CLI crate (`cli/`) incorporates the following direct third-party
open-source dependencies:

- **clap** (v4) - Apache-2.0 OR MIT (Copyright (c) 2015-2024 clap-rs developers)
- **futures-util** (v0.3) - Apache-2.0 OR MIT (Copyright (c) 2016-2024 The Rust Project Developers)
- **reqwest** (v0.12) - Apache-2.0 OR MIT (Copyright (c) 2016-2024 Sean McArthur)
- **serde** (v1.0) - Apache-2.0 OR MIT (Copyright (c) 2014-2024 Erick Tryzelaar and David Tolnay)
- **serde_json** (v1.0) - Apache-2.0 OR MIT (Copyright (c) 2014-2024 Erick Tryzelaar and David Tolnay)
- **tokio** (v1.40) - MIT (Copyright (c) 2024 Tokio Contributors)
- **toml** (v0.8) - Apache-2.0 OR MIT (Copyright (c) 2014-2024 Alex Crichton and toml-rs developers)
- **url** (v2) - Apache-2.0 OR MIT (Copyright (c) 2013-2024 The rust-url developers)

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

```text
Apache License, Version 2.0

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
