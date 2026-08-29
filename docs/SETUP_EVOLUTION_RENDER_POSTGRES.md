# 🚀 Guia de Configuração: Evolution API + PostgreSQL no Render

Este guia ensina como provisionar a **Evolution API** com persistência em **PostgreSQL** dentro da sua conta do **Render (Plano Gratuito / Free Tier)**, garantindo que o WhatsApp **nunca desconecte ou perca a sessão** durante deploys e reinicializações.

---

## 🏗️ Como Funciona a Arquitetura

1. **Render PostgreSQL (Banco de Dados):** Guarda de forma persistente todos os tokens de sessão, credenciais criptográficas e dados da conexão do WhatsApp.
2. **Evolution API (Web Service):** Gerencia a conexão com os servidores do WhatsApp e se comunica com o PostgreSQL.
3. **EMAÚS Barbearia Backend (Web Service Principal):** Envia notificações automáticas (agendamentos, lembretes de 4h, confirmações de pagamento) via requisições HTTP REST seguras para a Evolution API.

---

## 📌 Passo 1: Criar o Banco PostgreSQL no Render

1. Acesse o [Dashboard do Render](https://dashboard.render.com/).
2. Clique no botão **New +** no canto superior direito e selecione **PostgreSQL**.
3. Preencha as configurações:
   * **Name:** evolution-db
   * **Database:** evolution
   * **User:** evolution_user
   * **Region:** Ohio (US East) *(ou a mesma região do seu app principal)*
   * **Plan:** Free
4. Clique em **Create Database**.
5. Quando o banco for criado, role até a seção **Connections** e copie o valor de:
   * **Internal Database URL** *(se a Evolution API estiver no Render)* ou **External Database URL**.

---

## 📌 Passo 2: Criar o Serviço da Evolution API no Render

1. No Dashboard do Render, clique em **New +** > **Web Service**.
2. Selecione a opção **Deploy an existing image from a registry**.
3. No campo **Image URL**, digite:
   `	ext
   atendai/evolution-api:v2.1.2
   `
4. Clique em **Next**.
5. Preencha os campos básicos:
   * **Name:** evolution-api-emaus
   * **Region:** Ohio (US East)
   * **Plan:** Free
6. Na seção **Environment Variables**, adicione as seguintes variáveis:

| Variável | Valor Recomendado | Descrição |
| :--- | :--- | :--- |
| SERVER_URL | https://evolution-api-emaus.onrender.com | URL do seu serviço Evolution no Render |
| AUTHENTICATION_API_KEY | emaus_secret_token_2026_x89 | Chave secreta de autenticação (crie uma forte) |
| DATABASE_PROVIDER | postgresql | **Ativa a persistência em banco** |
| DATABASE_CONNECTION_URI | *(Cole a Internal Database URL do Passo 1)* | Conexão com o PostgreSQL do Render |
| DATABASE_SAVE_DATA_INSTANCE | 	rue | Salva instâncias no banco |
| DATABASE_SAVE_DATA_SESSIONS | 	rue | **Salva tokens de sessão no banco (Impede deslogar)** |
| DATABASE_SAVE_DATA_CHATS | 	rue | Salva histórico básico de chats |
| DATABASE_SAVE_MESSAGE_UPDATE | 	rue | Atualiza status de entrega |
| CONFIG_SESSION_PHONE_CLIENT | EMAUS Barbearia | Nome exibido nos aparelhos conectados |
| QRCODE_LIMIT | 30 | Limite de tentativas de QR Code |

7. Clique em **Create Web Service**.
8. Aguarde o deploy finalizar (status **Live 🟢**).

---

## 📌 Passo 3: Conectar a Barbearia à Evolution API

Agora que a sua Evolution API está rodando no Render com PostgreSQL, conecte o backend da barbearia:

1. No Dashboard do Render, abra o serviço do seu backend principal (arbearia-app).
2. Acesse a aba **Environment** e adicione:

`env
EVOLUTION_API_URL=https://evolution-api-emaus.onrender.com
EVOLUTION_API_KEY=emaus_secret_token_2026_x89
EVOLUTION_INSTANCE_NAME=emaus-barbearia
`

3. Clique em **Save Changes** (o Render fará o deploy automático em 30 segundos).

---

## 📌 Passo 4: Conectar o WhatsApp no Painel Admin

1. Abra o Painel Administrativo da barbearia (dmin.html) e faça login.
2. Acesse a aba **WhatsApp do Barbeiro**.
3. Digite o número com DDD (ex: 11993448991).
4. Clique em **Gerar Código de 8 Dígitos** (ou escaneie o QR Code se preferir).
5. No WhatsApp do seu celular:
   * Acesse **Configurações / Aparelhos Conectados** > **Conectar um aparelho**.
   * Toque em **Conectar com número de telefone**.
   * Digite o código de 8 dígitos exibido no painel.

**Pronto!** A sessão do WhatsApp está conectada e salva permanentemente no PostgreSQL. Mesmo que o Render reinicie ou faça novos deploys, a conexão nunca mais cairá! 💈🚀