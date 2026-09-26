// Porta de entrada da assinatura (edição Pro). Hoje ela deixa passar: é só a costura pronta
// para quando a cobrança pelo Mercado Pago entrar.
//
// LEIA ANTES DE IMPLEMENTAR:
// Uma extensão roda inteiramente na máquina de quem instalou, e o código dela é legível por
// qualquer pessoa. Qualquer verificação feita SÓ aqui dentro pode ser removida por quem quiser.
// Então a checagem real precisa de um servidor seu:
//
//   1. A pessoa assina no Mercado Pago (preapproval, R$400/mês) e recebe uma CHAVE.
//   2. Ela cola a chave no popup; a extensão guarda em chrome.storage.
//   3. A cada início de sessão a extensão chama SEU servidor: "esta chave está em dia?".
//      Só o servidor conhece o access token do Mercado Pago — ele nunca pode vir para cá.
//   4. O servidor responde com um "vale até <data>" ASSINADO. A extensão guarda a resposta e
//      trabalha offline dentro desse prazo (a live não pode parar por falta de internet).
//
// O que isso protege: uso casual sem pagar. O que não protege: alguém decidido a editar o
// código. Para esse caso o que funciona é o serviço ficar do lado do servidor, não a trava.
(function (raiz) {
  const CHAVE_ARMAZENADA = "licenca";
  const FOLGA_OFFLINE_DIAS = 3; // tolerância se o servidor estiver fora do ar

  /** Estado atual da licença, sem chamar rede. */
  async function estadoLicenca() {
    const ed = raiz.EDICAO || { precisaLicenca: false };
    if (!ed.precisaLicenca) return { ok: true, motivo: "edição pessoal" };
    let guardada = null;
    try {
      const g = await chrome.storage.local.get(CHAVE_ARMAZENADA);
      guardada = g[CHAVE_ARMAZENADA] || null;
    } catch {
      guardada = null;
    }
    if (!guardada || !guardada.valeAte) return { ok: false, motivo: "sem assinatura ativa" };
    const prazo = Date.parse(guardada.valeAte);
    if (Number.isNaN(prazo)) return { ok: false, motivo: "assinatura ilegível" };
    const folga = prazo + FOLGA_OFFLINE_DIAS * 86400000;
    if (Date.now() > folga) return { ok: false, motivo: "assinatura vencida" };
    return { ok: true, motivo: Date.now() > prazo ? "vencida, em período de tolerância" : "em dia", valeAte: guardada.valeAte };
  }

  /** Deixa trabalhar? Enquanto a cobrança não existe, sempre sim. */
  async function podeTrabalhar() {
    const ed = raiz.EDICAO || { precisaLicenca: false };
    if (!ed.precisaLicenca) return true;
    const st = await estadoLicenca();
    return st.ok;
  }

  raiz.Licenca = { estadoLicenca, podeTrabalhar, CHAVE_ARMAZENADA };
})(typeof globalThis !== "undefined" ? globalThis : self);
