fn main() {
    // 监视前端目录：ui 下任何文件变化都会触发重新编译，确保新 UI 嵌入 exe
    println!("cargo:rerun-if-changed=../ui");
    tauri_build::build()
}
