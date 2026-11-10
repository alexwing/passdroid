#!/bin/sh
# uso (WSL): sh run.sh   -- ejecuta ambas fixtures, contraseña incorrecta y tiempos
cd "$(dirname "$0")"
G=../../fixtures/golden
export FN_PASSWORD=phase0-golden-vectors
for f in desktop-64mib android-32mib; do
  echo "== $f"; ./fn_decrypt_x64 $G/$f.pdvault out/${f}.json; echo "rc=$?"
done
echo "== wrong password"
FN_PASSWORD=wrong-password-xyz ./fn_decrypt_x64 $G/desktop-64mib.pdvault out/wrong.json; echo "rc=$?"; ls out/wrong.json 2>&1
for f in desktop-64mib android-32mib; do
  for i in 1 2 3; do echo -n "$f run$i: "; ./fn_decrypt_x64 $G/$f.pdvault out/t.json 2>&1 | grep -o 'clave: [0-9]* ms'; done
done
