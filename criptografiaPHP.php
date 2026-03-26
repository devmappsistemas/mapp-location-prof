<?php

$keyB64 = "k0NwzXCJs+eICHhFRDJf0TcoXd5cqnkH/s6FiUvhFuI=";

if (!$keyB64) {
  throw new Exception("Defina BODY_ENC_KEY_B64");
}


$key = base64_decode($keyB64, true);
if ($key === false || strlen($key) !== 32) {
  throw new Exception("Chave inválida: precisa ser base64 de 32 bytes.");
}
function encryptBodyJson(array $data, string $keyB64): array
{
  $key = base64_decode($keyB64, true);
  if ($key === false || strlen($key) !== 32) {
    throw new Exception("Chave inválida (precisa 32 bytes).");
  }

  $iv = random_bytes(12); // 12 bytes recomendado para GCM
  $plaintext = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  if ($plaintext === false) throw new Exception("Falha ao serializar JSON.");


  $tag = '';
  $ciphertext = openssl_encrypt(
    $plaintext,
    'aes-256-gcm',
    $key,
    OPENSSL_RAW_DATA,
    $iv,
    $tag,
    '',   // AAD opcional (deixe igual no Node se usar)
    16    // tamanho do tag (16 é padrão/recomendado)
  );

  if ($ciphertext === false) throw new Exception("Falha ao criptografar.");

  return [
    "alg" => "A256GCM",
    "iv"  => base64_encode($iv),
    "tag" => base64_encode($tag),
    "data" => base64_encode($ciphertext),
  ];
}


// Exemplo de uso:
// $payload = encryptBodyJson([
//   "termosBusca" => "rua dos tupis 123 belo",
// ], $keyB64);


$payload = encryptBodyJson([
  "tipo" => "T",
  "messageId" => "wamid.HBgMNTUzMTkyMzc2ODU0FQIAEhggQUNDRTBCQjYxNjBEN0RFMDU0RjBDREU0NUNBOTYxNjUA",
  "idAgentePedir" => "243",
  "idConfig" => "24",
  "tipoAgente" => "SUPORTE",
], $keyB64); 

/*
$payload = encryptBodyJson([
  [
    "idExpresso" => "9",
    "empresa" => "Heloise e Juan Fotografias ME",
    "nome" => "Francisca Aurora Louise dos Santos",A
    "email" => "marketing@heloiseejuanfotografiasme.com.br",
  ],
  [
    "idExpresso" => "9",
    "empresa" => "Agatha e Milena Joalheria ME",
    "nome" => "Mirella Natália Galvão",
    "email" => "compras@agathaemilenajoalheriame.com.br",
  ],
], $keyB64);
*/

header('Content-Type: application/json; charset=utf-8');
echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
