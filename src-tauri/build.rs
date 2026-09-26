fn main() {
    // Garante que o recurso de ícone do .exe seja regenerado quando o ícone mudar
    // (sem isso o build script não reexecuta e o executável fica com o ícone antigo).
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::build()
}
