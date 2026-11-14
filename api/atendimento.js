
const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Método não permitido" });
  }

  try {
    const { codigo, token } = req.body || {};

    if (
      typeof codigo !== "string" ||
      !/^[A-Za-z0-9-]{8,64}$/.test(codigo)
    ) {
      return res.status(400).json({ erro: "Código inválido" });
    }

    const verificacao = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: process.env.TURNSTILE_SECRET_KEY,
          response: token
        })
      }
    );

    const resultado = await verificacao.json();

    if (!resultado.success) {
      return res.status(403).json({
        erro: "Verificação de segurança não aprovada"
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data, error } = await supabase
      .from("atendimentos_teste")
      .insert({
        codigo,
        valor: 0,
        status: "pendente",
        origem: "site"
      })
      .select("codigo")
      .single();

    if (error) throw error;

    return res.status(201).json({
      sucesso: true,
      codigo: data.codigo
    });
  } catch (error) {
    console.error("Erro no atendimento:", error);
    return res.status(500).json({
      erro: "Erro ao registrar solicitação"
    });
  }
};
