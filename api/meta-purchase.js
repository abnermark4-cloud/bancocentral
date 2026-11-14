const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const origemPermitida = "https://painel-atendimentos-rho.vercel.app";
  const origem = req.headers.origin;

  if (origem === origemPermitida) {
    res.setHeader("Access-Control-Allow-Origin", origemPermitida);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    return res.status(origem === origemPermitida ? 204 : 403).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Método não permitido" });
  }

  const auth = req.headers.authorization || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!jwt) {
    return res.status(401).json({ erro: "Não autenticado" });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const pixelId = process.env.META_PIXEL_ID;
  const metaToken = process.env.META_ACCESS_TOKEN;

  if (!url || !key || !pixelId || !metaToken) {
    return res.status(503).json({
      erro: "Servidor não configurado (verifique variáveis do Supabase e Meta na Vercel)"
    });
  }

  const supabase = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  try {
    // 1. Valida sessão do usuário
    const { data: authData, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !authData.user) {
      return res.status(401).json({ erro: "Sessão inválida" });
    }

    // 2. Valida permissão na tabela admins_teste
    const { data: admin, error: adminError } = await supabase
      .from("admins_teste")
      .select("user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    if (adminError || !admin) {
      return res.status(403).json({ erro: "Sem permissão" });
    }

    // 3. Lê o atendimento_id enviado pelo painel
    const { atendimento_id } = req.body || {};
    if (!atendimento_id) {
      return res.status(400).json({ erro: "atendimento_id é obrigatório" });
    }

    // 4. Busca os dados do atendimento (valor, código, fbc, fbp, event_id, etc.)
    const { data: atendimento, error: atendError } = await supabase
      .from("atendimentos_teste")
      .select("*")
      .eq("id", atendimento_id)
      .maybeSingle();

    if (atendError || !atendimento) {
      return res.status(404).json({ erro: "Atendimento não encontrado" });
    }

    if (atendimento.status !== "pago") {
      return res.status(400).json({ erro: "Atendimento ainda não consta como pago" });
    }

    // 5. Busca ou cria o registro na fila meta_purchase_outbox para controle de idempotência
    let { data: outbox } = await supabase
      .from("meta_purchase_outbox")
      .select("*")
      .eq("atendimento_id", atendimento_id)
      .maybeSingle();

    const eventId =
      outbox?.event_id ||
      atendimento.meta_event_id ||
      `purchase_${atendimento.codigo || atendimento.id}`;

    // Prevenção de duplicidade: se já foi enviado com sucesso, apenas retorna 200
    if (outbox?.status === "enviado" || atendimento.meta_purchase_enviado_em) {
      return res.status(200).json({
        sucesso: true,
        ja_enviado: true,
        event_id: eventId,
        mensagem: "Evento Purchase já havia sido enviado anteriormente"
      });
    }

    const tentativasAtuais = (outbox?.tentativas || 0) + 1;

    if (!outbox) {
      const { data: novoOutbox, error: insertError } = await supabase
        .from("meta_purchase_outbox")
        .insert({
          atendimento_id: atendimento.id,
          event_id: eventId,
          status: "processando",
          tentativas: tentativasAtuais
        })
        .select("*")
        .single();

      if (insertError) throw insertError;
      outbox = novoOutbox;
    } else {
      await supabase
        .from("meta_purchase_outbox")
        .update({
          status: "processando",
          tentativas: tentativasAtuais
        })
        .eq("atendimento_id", atendimento.id);
    }

    // 6. Monta o payload da Conversions API (CAPI) da Meta
    // Garante formatação correta do fbc caso apenas o fbclid bruto tenha sido salvo
    const fbcFormatado =
      atendimento.fbc ||
      (atendimento.fbclid
        ? `fb.1.${Math.floor(new Date(atendimento.criado_em || Date.now()).getTime() / 1000)}.${atendimento.fbclid}`
        : undefined);

    const payloadMeta = {
      data: [
        {
          event_name: "Purchase",
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          action_source: "website",
          event_source_url: atendimento.origem || origemPermitida,
          user_data: {
            fbc: fbcFormatado,
            fbp: atendimento.fbp || undefined,
            external_id: atendimento.codigo ? [String(atendimento.codigo)] : undefined
          },
          custom_data: {
            currency: "BRL",
            value: Number(atendimento.valor || 0),
            order_id: String(atendimento.codigo || atendimento.id)
          }
        }
      ]
      // Se quiser testar na aba "Eventos de Teste" da Meta, adicione META_TEST_CODE na Vercel:
      // ...(process.env.META_TEST_CODE ? { test_event_code: process.env.META_TEST_CODE } : {})
    };

    // 7. Envia para a Graph API da Meta
    const metaResponse = await fetch(
      `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${metaToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadMeta)
      }
    );

    const metaResult = await metaResponse.json();
    const agoraIso = new Date().toISOString();

    if (metaResponse.ok && metaResult.events_received >= 1) {
      // Atualiza outbox e atendimento como enviados
      await Promise.all([
        supabase
          .from("meta_purchase_outbox")
          .update({
            status: "enviado",
            enviado_em: agoraIso,
            ultimo_erro: null
          })
          .eq("atendimento_id", atendimento.id),
        supabase
          .from("atendimentos_teste")
          .update({
            meta_event_id: eventId,
            meta_purchase_enviado_em: agoraIso,
            meta_enviado_em: agoraIso
          })
          .eq("id", atendimento.id)
      ]);

      return res.status(200).json({
        sucesso: true,
        event_id: eventId,
        meta: metaResult
      });
    } else {
      // Registra a resposta de erro da Meta na fila para diagnóstico
      const erroDetalhe = JSON.stringify(metaResult);

      await supabase
        .from("meta_purchase_outbox")
        .update({
          status: "erro",
          ultimo_erro: erroDetalhe
        })
        .eq("atendimento_id", atendimento.id);

      return res.status(502).json({
        erro: "Meta rejeitou o evento Purchase",
        detalhe: metaResult
      });
    }
  } catch (error) {
    console.error("Erro no endpoint meta-purchase:", error.message);

    // Tenta registrar erro inesperado na outbox se houver atendimento_id
    if (req.body?.atendimento_id) {
      await supabase
        .from("meta_purchase_outbox")
        .update({
          status: "erro",
          ultimo_erro: error.message
