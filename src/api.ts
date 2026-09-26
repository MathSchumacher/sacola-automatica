import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------- tipos espelhados do backend ----------

export interface ProductQuery {
  keyword?: string;
  shopId?: number;
  itemId?: number;
  listType?: number;
  sortType?: number;
  isAMSOffer?: boolean;
  isKeySeller?: boolean;
  page: number;
  limit: number;
}

export interface ProductOffer {
  itemId: number;
  shopId: number;
  productName: string;
  productLink: string;
  offerLink: string;
  imageUrl: string;
  priceMin: number;
  priceMax: number;
  priceDiscountRate: number;
  sales: number;
  ratingStar: number;
  commissionRate: number;
  commission: number;
  shopName: string;
}

export interface ProductPage {
  nodes: ProductOffer[];
  pageInfo: { page: number; limit: number; hasNextPage: boolean };
}

export interface History {
  samples: number;
  avgPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  prevPrice: number | null;
}

export interface PeerStats {
  keyword: string;
  median: number;
  p25: number;
  count: number;
}

export type DealKind = "anomaly" | "drop" | "discount" | "none";

export interface DealEval {
  dropVsAvgPct: number | null;
  dropVsPrevPct: number | null;
  isLowestEver: boolean;
  /** preço ÷ mediana dos pares (0.05 = 95% abaixo do normal) */
  peerRatio: number | null;
  peerMedian: number | null;
  peerKeyword: string | null;
  peerCount: number;
  isPriceAnomaly: boolean;
  newSellerHint: boolean;
  kind: DealKind;
  score: number;
  qualifies: boolean;
  reasons: string[];
}

export interface Deal {
  itemId: number;
  shopId: number;
  productName: string;
  productLink: string;
  offerLink: string;
  imageUrl: string;
  shopName: string;
  priceMin: number;
  priceMax: number;
  discountRate: number;
  sales: number;
  rating: number;
  commissionRate: number;
  commission: number;
  firstSeen: string;
  lastSeen: string;
  notifiedAt: string | null;
  history: History;
  peers: PeerStats | null;
  eval: DealEval;
  inLive: boolean;
}

export type FilterKind = "" | "anomaly" | "discount";

export interface DealFilter {
  keyword: string;
  onlyQualifying: boolean;
  minScore: number;
  maxPrice: number;
  minSales: number;
  excludeInLive: boolean;
  sort: "score" | "peer" | "discount" | "drop" | "price" | "sales" | "commission" | "recent";
  limit: number;
  seenWithinHours: number;
  kind: FilterKind;
}

export interface PricePoint {
  capturedAt: string;
  priceMin: number;
  discountRate: number;
  sales: number;
}

export interface SavedSearch {
  id: number;
  keyword: string;
  listType: number | null;
  sortType: number | null;
  pages: number;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastResult: string | null;
  huntLowPrice: boolean;
}

export interface SearchResult extends ProductPage {
  peers: PeerStats | null;
}

export interface LiveItem {
  itemId: number;
  position: number;
  addedAt: string;
  source: string;
  note: string | null;
  shopId: number;
  productName: string;
  productLink: string;
  offerLink: string;
  imageUrl: string;
  priceMin: number;
  discountRate: number;
  sales: number;
  commissionRate: number;
}

export interface Thresholds {
  minDiscountRate: number;
  minDropVsAvg: number;
  minSales: number;
  minHistorySamples: number;
  /** preço ÷ mediana dos pares abaixo do qual é "fora da curva" (0.35) */
  maxPeerRatio: number;
  minPeerCount: number;
}

export interface AutoLiveRules {
  enabled: boolean;
  maxItems: number;
  minScore: number;
  keyword: string;
  maxPrice: number;
  replace: boolean;
  kind: FilterKind;
}

export interface AppSettings {
  appId: string;
  secret: string;
  intervalMinutes: number;
  maxPagesPerSearch: number;
  pageSize: number;
  thresholds: Thresholds;
  notifications: boolean;
  historyDays: number;
  autoLive: AutoLiveRules;
}

export interface ScanStatus {
  scanning: boolean;
  lastRunAt: string | null;
  lastSummary: string | null;
  lastError: string | null;
  nextRunAt: string | null;
}

export interface ScanSummary {
  searchesRun: number;
  requests: number;
  productsReceived: number;
  newProducts: number;
  priceChanges: number;
  qualifyingDeals: number;
  anomalies: number;
  notified: number;
  autoLiveAdded: number;
  errors: string[];
  durationMs: number;
}

export interface AppStatus {
  mode: "mock" | "live";
  hasCredentials: boolean;
  appId: string;
  productsTracked: number;
  scan: ScanStatus;
  version: string;
}

export interface ConnectionTest {
  ok: boolean;
  message: string;
  sample: string | null;
}

export type ExportFormat = "ids" | "ids_comma" | "links" | "offer_links" | "csv";

// ---------- comandos ----------

export const api = {
  getStatus: () => invoke<AppStatus>("get_status"),
  getSettings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) => invoke<AppSettings>("save_settings", { settings }),
  testConnection: () => invoke<ConnectionTest>("test_connection"),
  searchProducts: (query: ProductQuery) => invoke<SearchResult>("search_products", { query }),
  getPeerStats: (keyword: string) => invoke<PeerStats | null>("get_peer_stats", { keyword }),
  listDeals: (filter: DealFilter) => invoke<Deal[]>("list_deals", { filter }),
  getProductHistory: (itemId: number) => invoke<PricePoint[]>("get_product_history", { itemId }),
  listSearches: () => invoke<SavedSearch[]>("list_searches"),
  addSearch: (search: { keyword: string; listType?: number; sortType?: number; pages: number; huntLowPrice?: boolean }) =>
    invoke<SavedSearch>("add_search", { search }),
  setSearchEnabled: (id: number, enabled: boolean) => invoke<void>("set_search_enabled", { id, enabled }),
  deleteSearch: (id: number) => invoke<void>("delete_search", { id }),
  runScanNow: () => invoke<ScanSummary>("run_scan_now"),
  listLive: () => invoke<LiveItem[]>("list_live"),
  addToLive: (itemIds: number[]) => invoke<number>("add_to_live", { itemIds }),
  removeFromLive: (itemId: number) => invoke<void>("remove_from_live", { itemId }),
  moveLiveItem: (itemId: number, delta: number) => invoke<void>("move_live_item", { itemId, delta }),
  clearLive: () => invoke<void>("clear_live"),
  autoFillLive: (rules?: AutoLiveRules, replace?: boolean) => invoke<number>("auto_fill_live", { rules, replace }),
  exportLive: (format: ExportFormat) => invoke<string>("export_live", { format }),
  exportLiveFile: (format: ExportFormat) => invoke<string>("export_live_file", { format }),
};

// ---------- eventos ----------

export const events = {
  onScanStatus: (cb: (s: ScanStatus) => void): Promise<UnlistenFn> => listen<ScanStatus>("scan:status", (e) => cb(e.payload)),
  onScanFinished: (cb: (s: ScanSummary) => void): Promise<UnlistenFn> =>
    listen<ScanSummary>("scan:finished", (e) => cb(e.payload)),
  onLiveChanged: (cb: () => void): Promise<UnlistenFn> => listen("live:changed", () => cb()),
  onSettingsChanged: (cb: () => void): Promise<UnlistenFn> => listen("settings:changed", () => cb()),
};

export const LIST_TYPES: { value: number | ""; label: string }[] = [
  { value: "", label: "Padrão" },
  { value: 0, label: "Recomendados" },
  { value: 1, label: "Maior comissão" },
  { value: 2, label: "Melhor desempenho" },
];

export const SORT_TYPES: { value: number | ""; label: string }[] = [
  { value: "", label: "Padrão" },
  { value: 1, label: "Relevância" },
  { value: 2, label: "Mais vendidos" },
  { value: 3, label: "Maior preço" },
  { value: 4, label: "Menor preço" },
  { value: 5, label: "Maior comissão" },
];
