# 端侧 embedding 性能评估（Rein 知识库 Phase 0）

> 目的：在写功能代码之前，用真实测量替换方案阶段的估算，并验证 ONNX Runtime 在 Rein 的三条构建链路上是否可行。
> 测量日期：2026-09-10 · 机器：本机 Windows x64（桌面开发机）

## 一、结论摘要

1. **ORT + int8 模型在进程内可用，语义正确**：`load-dynamic` 加载 50 ms，session 创建 132 ms（冷）/ 85 ms（热）。
2. **延迟比方案估算好一个数量级**：130 token 文本实测中位 **7.2 ms**，方案里估的是 90–150 ms。
3. **全量重建不再是痛点**：3000 条 × 130 token 实测 **16.8 s**（4 线程），方案里估的是 3–5 分钟。
4. **三条构建链路全部通过**：Windows x64、Windows ARM64、Android aarch64 交叉编译均成功，且**整棵依赖树无 C 代码**。
5. **真实成本在内存而非时间**：推理进程峰值工作集 **157.5 MB**。

## 二、测量方法

一次性 spike 工程（`ORT 2.0.0-rc.13` + `tokenizers 0.23.2` + `ndarray 0.17`），非 Rein 源码：

- 模型 `Xenova/bge-small-zh-v1.5` 的 `onnx/model_quantized.onnx`（int8 动态量化），池化取 `last_hidden_state` 的 CLS 位后做 L2 归一化。
- 延迟 = warmup 5 次后重复采样的中位数与 p90；短文本 40 次采样、长文本 15 次。
- 复现：`node scripts/fetch-ort-runtime.mjs --target win-x64` 取运行库；模型文件现在由应用在运行时按需下载（当年的拉取脚本已随内置模型移除）。

## 三、延迟实测

### 随输入长度（intra_threads=4，中位 / p90）

| 输入 | token | 中位 | p90 |
|---|---|---|---|
| 32 字符 | 34 | **2.3 ms** | 2.4 ms |
| 64 字符 | 66 | **4.2 ms** | 4.9 ms |
| 128 字符 | 130 | **7.2 ms** | 7.6 ms |
| 300 字符 | 302 | **16.3 ms** | 16.7 ms |
| 512 字符 | 512 | **25.1 ms** | 31.7 ms |

### 随线程数（130 token 档）

| intra_threads | 中位 | 3000 条重建推演 |
|---|---|---|
| 1 | 11.6 ms | 33.8 s |
| 2 | 6.4 ms | 19.3 s |
| 4 | 7.2 ms | 16.8 s |
| 8 | 4.2 ms | 14.5 s |

线程收益次线性：**2 线程已拿到大约 1.8 倍**，再往上边际很小。后台索引取 2 线程即可，把 CPU 让给 UI。

## 四、语义正确性

| 对照 | 余弦 |
|---|---|
| 「用户把深蹲换成了腿举，因为膝盖不舒服」↔「深蹲」 | +0.660 |
| 同上 ↔「膝盖」 | +0.586 |
| 同上 ↔「晚餐」 | +0.303 |
| 「腿部力量训练」↔「深蹲练腿」 | +0.698 |
| 「腿部力量训练」↔「练胸推举」 | +0.509 |
| 「腿部力量训练」↔「晚餐吃了什么」 | +0.179 |

同域对（0.66–0.70）与跨域对（0.18–0.30）分离清晰，int8 量化没有把语义压坏。

## 五、冷启动与内存

| 项 | 实测 |
|---|---|
| ORT 运行库动态加载 | 50 ms |
| session 创建（模型从磁盘读入） | 132 ms |
| session 创建（模型已在内存） | 49–88 ms |
| 进程峰值工作集 | **157.5 MB** |

内存是这次评估里唯一"比预期差"的项。缓解手段（Phase 2 落地时按需选）：配置 ORT arena（`session.enable_cpu_mem_arena=0`）、或按 load-dynamic 的低重建成本做**闲置释放**——session 重建只要 50–130 ms，所以"用完丢弃、下次重建"是可行的省内存策略。

## 六、与方案估算的差异

| 项 | 方案估算 | 实测 | 差异 |
|---|---|---|---|
| 130 token 单条 | 90–150 ms | 7.2 ms | **约 15 倍** |
| 512 token 单条 | 350–600 ms | 25.1 ms | **约 20 倍** |
| 3000 条全量重建 | 3–5 分钟 | 16.8 s | **约 11 倍** |

估算依据是 `FLOPs ≈ 2 × 参数 × token`（4 层 / hidden 512 / 24M 参数 → 130 token ≈ 6.2 GFLOP），再按 CPU 有效算力 40–70 GFLOPS 折算。偏差来源：

1. **int8 的有效吞吐被严重低估**——ORT 的 int8 kernel 在现代 x86 上远超"fp32 峰值 30–40%"这个假设。
2. **激活稀疏与算子融合**——ORT 的 Level3 图优化把 LayerNorm/GELU/残差做了融合，实际执行的算子数少于朴素计数。
3. 4 层小模型的实际访存模式比大模型友好，cache 命中率高。

结论：**第一性原理估算对量化小模型不可靠，这类问题必须实测**。

## 七、三端构建验证

| 目标 | 结果 | 说明 |
|---|---|---|
| `x86_64-pc-windows-msvc` | ✅ 通过并实测 | 原生构建 |
| `aarch64-pc-windows-msvc` | ✅ 通过 | 20.4 s |
| `aarch64-linux-android` | ✅ 通过 | 23.9 s，产物确认为 `ELF 64-bit ARM aarch64, for Android 24` |

**关键发现：整棵依赖树零 C 代码。** 这是两个选型换来的：

- `tokenizers` 用 `fancy-regex`（纯 Rust）而非默认的 `onig`——后者会引入 oniguruma 的 C 编译，是 Android 交叉编译的常见坑。注意 `tokenizers` 在 `default-features = false` 下会 `compile_error!`，**必须显式二选一**。
- `ort` 用 `load-dynamic`（`ort-sys/disable-linking`）而非默认的 `download-binaries`——编译期不链接 ORT，运行时由我们显式 `init_from()` 指定库路径。

因此 Android 交叉编译只需要指向 NDK 的链接器，无需新增任何 `jniLibs`/ABI/CC 配置。另外 `ort` 的 `default` 里含 `download-binaries`，**必须 `default-features = false`**，否则与 `load-dynamic` 冲突。

## 八、体积清单（实测）

| 产物 | 体积 | 来源 |
|---|---|---|
| `model_quantized.onnx`（int8） | 22.90 MB | ModelScope / HF |
| `tokenizer.json` | 429 KB | 同上 |
| `onnxruntime.dll`（Windows x64） | 15.08 MB | ORT v1.28.2 GitHub release |
| `onnxruntime.dll`（Windows ARM64） | 15.17 MB | 同上 |
| `libonnxruntime.so`（Android arm64-v8a） | **27.31 MB** | Maven AAR `onnxruntime-android:1.28.0` |

### 打包后的真实增量（2026-09-11 完整构建实测）

| 产物 | 之前 | 之后 | 增量 |
|---|---|---|---|
| Android APK（aarch64） | 14.6 MB | **71.9 MB** | **+57.3 MB** |
| Windows 安装包（NSIS x64） | 4.4 MB | **24.5 MB** | **+20.1 MB** |
| `rein.exe`（解压后） | 14.9 MB | 58.0 MB | +43.1 MB |

为什么 APK 增量比「模型 23 + 运行库 27 = 50」还多 7 MB：**Android 的 APK 对 native 库是不压缩存储的**（`extractNativeLibs=false`，页对齐直载），27.3 MB 的 `.so` 与 40.6 MB 的 `librein_lib.so`（内含 23 MB 模型）几乎原样计入。而 NSIS 安装包用 LZMA 压缩，58 MB 的 `rein.exe` 只占 24.5 MB 下载体积——**两端下载体积差近 3 倍，但解压后磁盘占用接近**。

两处与方案估算的偏差：ORT 运行库（Windows）比预估的 12 MB 大 25%，而 **Android 的 `.so` 比预估的 15 MB 大 82%**——AAR 里的动态库带了完整的 MLAS 与各执行后端，未做裁剪。

若要压缩：可自行用 `--minimal_build` 从源码构建只含 CPU EP 的 ORT，通常能砍到 5–8 MB，代价是引入一套 Android 源码构建流程；模型侧 int8 已是最小可用档（`model_q4.onnx` 52 MB、`model_q4f16.onnx` 29 MB 均不占优）。

### 完整构建验证（2026-09-11）

| 目标 | 结果 |
|---|---|
| Android APK（`aarch64-linux-android`） | ✅ 完整 APK 构建通过，`libonnxruntime.so` 与内含模型的 `librein_lib.so` 均在位 |
| Windows NSIS x64 | ✅ 完整安装包构建通过 |
| Windows ARM64 桌面 | ⚠️ 卡在既有依赖 `ring`（经 tokio-tungstenite 的 rustls 引入）需要 MSVC ARM64 工具链（vcvarsall）——**既有要求，与本次改动无关**；本次新增的 ort/tokenizers 在该目标零 C 代码，已单独验证可编译 |

## 九、对设计的修正

基于实测，方案里有三条判断需要更新：

1. **全量重建不再是需要"引导用户手动触发"的重操作**。桌面 17 秒、Android 按 1/4–1/5 吞吐折算约 1.5–2.5 分钟。可以改为**首次自动全量 + 进度条**，不必让用户做决策。
2. **写穿式即时索引变得可行**。单条 2–7 ms，意味着用户在待办里敲完一条就能立刻被检索到，不必等后台批量。后台线程保留用于批量与重算，但新写入的"最后一条"可以直接同步嵌入。
3. **线程数取 2**，而不是让 ORT 默认吃满核心。后台索引不该抢占 UI 的 CPU。

内存则相反，需要新增一条约束：**Android 上要考虑 ORT arena 收敛或闲置释放**，否则 157 MB 的峰值在低内存设备上会被系统杀掉。

## 十、复现步骤

```bash
node scripts/fetch-ort-runtime.mjs --target win-x64                 # ORT 1.28.2
node scripts/fetch-ort-runtime.mjs --target win-arm64
node scripts/fetch-ort-runtime.mjs --target android-arm64           # Maven AAR
```

运行库在 `.gitignore` 中，克隆仓库后需先执行上述脚本再构建。向量模型不参与构建：
默认关键词检索，需要本地语义检索时在应用内按需下载。

---

# 附录：本地模型可选化（2026-10-07 追加）

> 原评估定下「内置一颗 int8 小模型」；实际用起来，中文语义质量对小模型是硬约束。
> 于是把本地模型做成**注册表 + 按需下载**。2026-11-07 起安装包不再内置任何模型：
> 默认关键词检索，5 档模型全部按需下载（`bge-small` 仍是最轻的缺省档）。

## 可选清单（体积为实测字节数，经 hf-mirror 探测）

| id | 档位 | 维度 | 池化 | 体积 | 说明 |
|---|---|---|---|---|---|
| `bge-small-zh-v1.5-int8` | 轻量·中文 | 512 | CLS | 24.4 MB | 体积最小，缺省本地档；按需下载 |
| `bge-base-zh-v1.5-int8` | 标准·中文 | 768 | CLS | 103.3 MB | 中文语义明显更细，日常首选 |
| `bge-large-zh-v1.5-int8` | 高精度·中文 | 1024 | CLS | 327.8 MB | 中文检索天花板一档，桌面优先 |
| `bge-m3-int8` | 多语·超大 | 1024 | CLS | 586.8 MB | 100+ 语言、长文本；手机不建议 |
| `paraphrase-multilingual-MiniLM-L12-v2-int8` | 轻量·多语 | 384 | Mean | 135.4 MB | 多语折中档，384 维更省内存 |

## 几个必须记住的工程结论

1. **下载源用 `hf-mirror.com`（主）+ ModelScope（备）**：本机实测 `huggingface.co` 直连不通（curl 000），
   而 hf-mirror 五个模型文件全部 200；ModelScope 的 `api/v1/models/{repo}/repo?FilePath=` 形式也可达。
2. **换模型 = 换向量空间**：`kb_settings_set` 比较「嵌入身份」（模式 + 本地模型 + 云端模型）的指纹，
   变了就 `clear_vectors`；embedder 缓存同样按指纹作废（原来只比 mode，换云端模型不会重建——已修）。
3. **装完必须自检**：下载完成 → `LocalEmbedder::new` 加载 → `probe()` 真跑一条中文 → 维度不符就回滚删文件。
   否则一个坏模型会静静躺在磁盘上，等检索时才炸。
4. **池化不止 CLS**：BGE 系用 CLS，多语 MiniLM 系用带掩码的均值池化，注册表里带 `pooling` 字段。
5. **自检的真实价值**：`#[ignore]` 的真网络测试（`download_small_model_over_network`）一次跑通
   下载→落盘→加载→嵌入→删除全链路，实测 3.98 s（24 MB）。模型源换域名时这条会先红。
