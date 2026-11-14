
const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

const origemPermitida =
  "https://painel-atendimentos-rho.vercel.app";

const origem = req.headers.origin;

if (origem === origemPermitida) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    origemPermitida
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type"
  );
  res.setHeader("Vary", "Origin");
}

if (req.method === "OPTIONS") {
  return res.status(
    origem === origemPermitida ? 204 : 403
  ).end();
}

  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Método não permitido" });
  }

  const auth = req.headers.authorization || "";
  const jwt = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : null;

  if (!jwt) {
    return res.status(401).json({ erro: "Não autenticado" });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return res.status(503).json({ erro: "Servidor não configurado" });
  }

  const supabase = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  try {
    const { data: authData, error: authError } =
      await supabase.auth.getUser(jwt);

    if (authError || !authData.user) {
      return res.status(401).json({ erro: "Sessão inválida" });
    }

    const { data: admin, error: adminError } =
      await supabase
        .from("admins_teste")
        .select("user_id")
        .eq("user_id", authData.user.id)
        .maybeSingle();

    if (adminError || !admin) {
      return res.status(403).json({ erro: "Sem permissão" });
    }

    return res.status(200).json({
      sucesso: true,
      mensagem: "Autenticação administrativa validada"
    });
  } catch (error) {
    console.error("Erro de autenticação:", error.message);
    return res.status(500).json({
      erro: "Falha ao validar a solicitação"
    });
  }
};
