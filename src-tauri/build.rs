use std::path::Path;

/// 当前构建的目标平台。**必须读 cargo 提供的环境变量而不是 `cfg!()`**：
/// build.rs 本身是为宿主平台编译的，`cfg!(target_arch)` 永远是宿主的值，
/// 交叉编译（Windows ARM64 / Android 都在本机 x64 上构建）时会判错目标。
fn target_os() -> String {
    std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default()
}

fn target_arch() -> String {
    std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default()
}

/// ONNX Runtime 运行库体积大且可复现，不入库（见 .gitignore），
/// 由 scripts/fetch-ort-runtime.mjs 拉取。向量模型不再内置，无需在构建期准备。
///
/// 缺文件时 `include_bytes!` 抛出的报错只给一行路径，不易定位；这里提前拦一道，
/// 直接告诉使用者该跑哪条命令。
fn check_ort_assets() {
    // 运行库按目标平台取：Windows 内嵌进二进制（x64 / ARM64 各一份），
    // Android 走 jniLibs 由系统加载器按名字找，非 Windows 桌面走系统路径。
    let ort_rel = match (target_os().as_str(), target_arch().as_str()) {
        ("windows", "x86_64") => Some("resources/ort/win-x64/onnxruntime.dll"),
        ("windows", "aarch64") => Some("resources/ort/win-arm64/onnxruntime.dll"),
        ("android", "aarch64") => {
            Some("gen/android/app/src/main/jniLibs/arm64-v8a/libonnxruntime.so")
        }
        _ => None,
    };
    if let Some(p) = ort_rel {
        if !Path::new(p).exists() {
            panic!(
                "\n\n端侧 embedding 的 ONNX Runtime 素材缺失，构建无法继续：\n  - {p}\n\n\
                 请先执行（运行库走 GitHub Release / Maven）：\n  \
                 node scripts/fetch-ort-runtime.mjs --target all\n\n"
            );
        }
    }
}

fn main() {
    check_ort_assets();
    println!("cargo:rerun-if-changed=resources/ort");
    tauri_build::build()
}
