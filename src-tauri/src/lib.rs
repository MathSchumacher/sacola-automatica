mod commands;
mod db;
mod deals;
mod scheduler;
mod server;
mod shopee;
mod state;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("achadinhos.db");
            log::info!("banco de dados em {}", db_path.display());
            let conn = db::open(&db_path)?;
            app.manage(AppState::new(conn));
            scheduler::spawn(app.handle().clone());
            server::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::get_settings,
            commands::save_settings,
            commands::test_connection,
            commands::search_products,
            commands::get_peer_stats,
            commands::list_deals,
            commands::get_product_history,
            commands::list_searches,
            commands::add_search,
            commands::set_search_enabled,
            commands::delete_search,
            commands::run_scan_now,
            commands::list_live,
            commands::add_to_live,
            commands::remove_from_live,
            commands::move_live_item,
            commands::clear_live,
            commands::auto_fill_live,
            commands::export_live,
            commands::export_live_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
