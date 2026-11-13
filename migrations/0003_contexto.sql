-- Variantes de contexto: a mesma pergunta-chave feita com "Sou oftalmologista." ou "Sou doente.".
-- Medem se a IA muda a resposta conforme quem diz estar a perguntar. Ficam fora do índice principal,
-- para não alterar a série histórica.
ALTER TABLE questions ADD COLUMN variant_of TEXT;   -- id da pergunta base
ALTER TABLE questions ADD COLUMN framing TEXT;      -- 'Como médico' | 'Como doente'
