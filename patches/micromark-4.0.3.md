# micromark 4.0.3 adjacent-data resolver patch

The desktop build applies a local, narrowly scoped patch to the production and development text initializers of micromark 4.0.3. Its adjacent-data resolver repeatedly splices the remaining event array; many separate mergeable runs produce quadratic work. A single in-place compaction pass retains the same first enter/exit events, token objects, contexts and final endpoint, then delegates to the unchanged line-suffix resolver.

The problem was independently profiled in the CC SPACE 256 KiB browser stress workload. Local evidence is retained under the ignored `.local/harness-adoption/stress-head-profile*-artifacts` directories. This changes parsing cost only; CommonMark, GFM, math and rendering remain in the existing remark/react-markdown pipeline.

Upstream reference: [micromark PR #233](https://github.com/micromark/micromark/pull/233), head `a35dc80be379e8d6075426c76bbcbb4931e23bb6`, was open and unmerged when checked on 2026-10-31. It independently proposes the same compaction strategy. The local implementation was validated against the installed resolver; it is not represented as a released or merged upstream fix.

`scripts/patch-micromark.mjs` checks the package name/version and complete SHA-256 of both source files before writing either. Known patched files are accepted unchanged. Unknown versions or edits fail the build. No install lifecycle script or extra dependency is required. Remove this patch when a released upstream version fixes the hotspot, after checking semantic parity and the same browser stress workload.

| Source | Original SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `lib/initialize/text.js` | `1c5682291dbb6cea7f95edeb6d50421238b91752c9e0fb9485bdde44628ce090` | `66bc6ee479252a246524169257553571053f972dd68b6a2078f78bfeaa269da0` |
| `dev/lib/initialize/text.js` | `42f71a37602a65811779e2ae2977bd968504e2b54b575c1458ebb7dd0ca4ff66` | `eec12c6702987ad445320d76fcbae257ed1529c75872954d3244f43741886ba8` |

The adapted upstream source is distributed under the following complete license notice:

```text
(The MIT License)

Copyright (c) Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
