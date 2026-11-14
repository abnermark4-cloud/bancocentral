
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const DOMINIO = "bancocentral-beryl.vercel.app";
const ORIGEM = `https://${DOMINIO}`;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      erro: "Método não permitido"
    });
  }

  const origin = req.headers.origin;

  if (origin !== ORIGEM) {
    return res.status(403).json({
      erro: "Origem não autorizada"
    });
  }

  try {
    const {
  token,
  campanha_id,
  conjunto_id,
  anuncio_id,
  fbclid
} = req.body || {};

const validarId = (valor) =>
  typeof valor === "string" &&
  /^\d{1,30}$/.test(valor) ? valor : null;

const validarFbclid = (valor) =>
  typeof valor === "string" &&
  /^[A-Za-z0-9_.-]{1,200}$/.test(valor)
    ? valor
    : null;

    if (
      typeof token !== "string" ||
      token.length < 10 ||
      token.length > 2048
    ) {
      return res.status(400).json({
        erro: "Verificação de segurança ausente"
      });
    }

    const secret = process.env.TURNSTILE_SECRET_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!secret || !supabaseUrl || !supabaseKey) {
      console.error("Variáveis de ambiente ausentes");
      return res.status(503).json({
        erro: "Serviço temporariamente indisponível"
      });
    }

    // Validação do Turnstile no servidor
    const formulario = new URLSearchParams();
    formulario.append("secret", secret);
    formulario.append("response", token);

    const verificacao = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: formulario.toString(),
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!verificacao.ok) {
      throw new Error("Falha na verificação Turnstile");
    }

    const resultado = await verificacao.json();

    if (
      resultado.success !== true ||
      resultado.hostname !== DOMINIO
    ) {
      return res.status(403).json({
        erro: "Verificação de segurança inválida"
      });
    }

    // Gera um identificador sem coletar CPF
    const codigo =
      "SITE-" +
      crypto.randomUUID()
        .replace(/-/g, "")
        .slice(0, 16)
        .toUpperCase();

    const supabase = createClient(
      supabaseUrl,
      supabaseKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    // Registra apenas a solicitação
    const { data, error } = await supabase
      .from("atendimentos_teste")
      .insert({
  codigo,
  valor: 59.80,
  status: "pendente",
  origem: "site",
  campanha_id: validarId(campanha_id),
  conjunto_id: validarId(conjunto_id),
  anuncio_id: validarId(anuncio_id),
  fbclid: validarFbclid(fbclid)
})
      .select("codigo")
      .single();

    if (error) {
      console.error("Erro Supabase:", {
  code: error.code,
  message: error.message,
  details: error.details,
  hint: error.hint
});
      throw new Error("Falha ao registrar atendimento");
    }

    return res.status(201).json({
      sucesso: true,
      codigo: data.codigo
    });

  } catch (erro) {
    console.error("Erro na API:", erro.message);

    return res.status(500).json({
      erro: "Não foi possível registrar a solicitação"
    });
  }
};
