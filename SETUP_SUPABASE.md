# Configuração do Supabase - Passo a Passo

## ✅ Passo 1: Instalar Dependência

Execute no terminal:

```bash
npm install @supabase/supabase-js
```

## ✅ Passo 2: Criar Estrutura no Supabase

Acesse seu projeto no Supabase: https://tzamlllpmlemwessrdvs.supabase.co

1. Vá em **SQL Editor** (menu lateral)
2. Clique em **New Query**
3. Cole e execute o SQL abaixo:

```sql
-- 1. Criar extensão para vector (se ainda não existir)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Criar tabela documents (ajuste conforme sua estrutura)
CREATE TABLE IF NOT EXISTS documents (
    id BIGSERIAL PRIMARY KEY,
    content TEXT,
    metadata JSONB,
    embedding vector(1536) -- Tamanho para text-embedding-3-small
);

-- 3. Criar índice para busca semântica (melhora performance)
CREATE INDEX IF NOT EXISTS documents_embedding_idx 
ON documents 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- 4. Criar função match_documents para busca semântica
CREATE OR REPLACE FUNCTION match_documents(
    query_embedding vector(1536),
    match_threshold float DEFAULT 0.7,
    match_count int DEFAULT 50,
    filter jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    id bigint,
    content text,
    metadata jsonb,
    similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        documents.id,
        documents.content,
        documents.metadata,
        1 - (documents.embedding <=> query_embedding) as similarity
    FROM documents
    WHERE
        -- Filtro por metadata
        (filter->>'nomeTreinamento' IS NULL OR documents.metadata->>'nomeTreinamento' = filter->>'nomeTreinamento')
        AND (filter->>'idConfig' IS NULL OR documents.metadata->>'idConfig' = filter->>'idConfig')
        AND (filter->>'contexto' IS NULL OR documents.metadata->>'contexto' = filter->>'contexto')
        -- Filtro por similaridade
        AND (1 - (documents.embedding <=> query_embedding)) >= match_threshold
    ORDER BY documents.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
```

## ✅ Passo 3: Testar a Conexão

Após executar o SQL, teste a rota:

```bash
POST http://localhost:4049/api/v1/agente/buscar-base-conhecimento
```

**Body:**
```json
{
  "query": "Como configurar faturamento automático?",
  "topK": 10,
  "metadata": {
    "nomeTreinamento": "Treinamento_base",
    "idConfig": "386",
    "contexto": "SUPORTE"
  }
}
```

## 📝 Estrutura da Tabela `documents`

A tabela deve ter estas colunas:

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | BIGSERIAL | ID único (auto-incremento) |
| `content` | TEXT | Conteúdo do documento |
| `metadata` | JSONB | Metadados (nomeTreinamento, idConfig, contexto) |
| `embedding` | vector(1536) | Vetor de embedding |

### Exemplo de metadata:

```json
{
  "nomeTreinamento": "Treinamento_base",
  "idConfig": "386",
  "contexto": "SUPORTE"
}
```

## 🔍 Verificar se Funcionou

1. **Teste a busca**: Use a rota acima
2. **Verifique os logs**: Se houver erro, aparecerá no console
3. **Teste com dados**: Insira alguns documentos de teste no Supabase

## ⚠️ Troubleshooting

### Erro: "extension vector does not exist"
- Execute: `CREATE EXTENSION IF NOT EXISTS vector;`
- Verifique se a extensão está habilitada no projeto

### Erro: "function match_documents does not exist"
- Execute o SQL do Passo 2 novamente
- Verifique se a função foi criada: `SELECT * FROM pg_proc WHERE proname = 'match_documents';`

### Busca retorna vazio
- Verifique se há documentos na tabela: `SELECT COUNT(*) FROM documents;`
- Verifique se os embeddings foram gerados: `SELECT id, content, embedding IS NOT NULL as has_embedding FROM documents LIMIT 5;`
- Tente reduzir o `match_threshold` (padrão é 0.7)

## 📚 Próximos Passos

Depois que tudo estiver funcionando, você pode:
1. Inserir documentos na tabela `documents`
2. Gerar embeddings para os documentos existentes
3. Testar a busca semântica completa
