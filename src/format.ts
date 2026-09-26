const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const intBR = new Intl.NumberFormat("pt-BR");

export const fmtBRL = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "—" : brl.format(v));
export const fmtInt = (v: number | null | undefined) => (v == null ? "—" : intBR.format(Math.round(v)));
export const fmtPct = (v: number | null | undefined, digits = 0) =>
  v == null || Number.isNaN(v) ? "—" : `${v.toFixed(digits).replace(".", ",")}%`;

/** Comissão vem como fração (0.05) → "5%". */
export const fmtCommission = (rate: number) => fmtPct(rate * 100, 1);

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return iso;
  const diffMin = Math.round((d - Date.now()) / 60000);
  const abs = Math.abs(diffMin);
  const txt = abs < 1 ? "agora" : abs < 60 ? `${abs} min` : abs < 60 * 48 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  if (abs < 1) return txt;
  return diffMin < 0 ? `há ${txt}` : `em ${txt}`;
}

/** Aceita "19,90" ou "19.90". */
export function parseNumberBR(s: string): number {
  const n = Number(String(s).trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/** Versão mais permissiva: troca só a vírgula (inputs numéricos simples). */
export function parseDecimal(s: string): number {
  const n = Number(String(s).trim().replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}
