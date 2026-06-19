#!/bin/bash
# Phase 1.5 on-chain re-pin: point every contract at the v5 verifier + its v5 canonical image_id.
# Run from contract/ on Windows (Git Bash). Deployer-auth (admin) gated.
set -u
NET=testnet
SRC=zkorage-deployer
V=CBAPC663PTWIWDLYNCG5WAD5MIZF4SKY43U6L2NM5ZUU5XFOS4JDYAFW

CLAIM=973c983125ad3a9f115b2f4d8d12ec39e3f1b107f15c57643f72baf36f923502
IDENTITY=a5198a5a359359b08dc1b0faa260e253d413dea5035c1375d19b742f7deaeb3b
COMPLIANCE=54d5921c58280b63ef80905ffe6d4e506f77031b53ff2a347fe84ace423cb129
PAYROLL=2c9cc61b0dc261290209067783365842eca14b77981486eb535bbacfbd1e2785
ACCREDITED=26d743739468287991220d6da2cb891616aa7c6b90da2eda9836395f31bcc947
SEAL=8f24842d0647a0671ed1b898f6a42c2d104ff04b3f152067c93d9449bf65a3ce
MEMBERSHIP=9550a12e84a9b26bc3926e79e271dc0f1a740f45d86f88c19d3e3e438939011c
DOCAUTH=e4f4a356cbacde61ef901500a6d396d2fa83a666b31224be2848fd69bbff8741

POLICY=CDQ2PA27UTJDLPA4XTGG647SNTMUYO2KRFGS3SW5SMNBIWRB7JVCZXQ6
GATE=CCTHDSEQFMAOPJXI5GVSUTMXO5DHZUJS7YQYAEIGKFMOAMTNDKSL4FWT
COMPL=CDSA3PUL7OZ5HKLIT73ZTG64TLYK4QTO5ZHZKHA3JBS76R5L5Q2EO4FV
PAYR=CA6XYNHYR3GS3TQ24Z2Y45SXRNQDA5Z4L2PU54YM2WUKSMPVWVMYZCDA
ACCR=CCLSXZBOPCAJQS6L54EAGZQHTD5QUES2OSYCFX5XJT6ZXSICRPS4QKQZ
FUND=CDEV4METH74Z42DFV6HC3VLF3PWACXVIIS7C3PLK6CZT2B6L5I3YBC2L
DR=CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN

inv() { # id, then -- args...
  local id=$1; shift
  stellar contract invoke --source "$SRC" --network "$NET" --id "$id" -- "$@" 2>&1 | grep -ivE "config migrate|local config was found" | tail -1
}

echo "== policy (PoR) =="
echo -n "set_verifier: "; inv $POLICY set_verifier --verifier $V
echo -n "set_image_id(claim): "; inv $POLICY set_image_id --image_id $CLAIM
echo "== gate (KYC) =="
echo -n "set_verifier: "; inv $GATE set_verifier --verifier $V
echo -n "set_image_id(identity): "; inv $GATE set_image_id --image_id $IDENTITY
echo "== compliance =="
echo -n "set_verifier: "; inv $COMPL set_verifier --verifier $V
echo -n "set_image_id(compliance): "; inv $COMPL set_image_id --image_id $COMPLIANCE
echo "== payroll =="
echo -n "set_verifier: "; inv $PAYR set_verifier --verifier $V
echo -n "set_image_id(payroll): "; inv $PAYR set_image_id --image_id $PAYROLL
echo "== accredited =="
echo -n "set_verifier: "; inv $ACCR set_verifier --verifier $V
echo -n "set_image_id(accredited): "; inv $ACCR set_image_id --image_id $ACCREDITED
echo "== fundraise =="
echo -n "set_verifier: "; inv $FUND set_verifier --verifier $V
echo -n "set_image_id(revenue): "; inv $FUND set_image_id --revenue_image_id $CLAIM
echo "== dataroom (seal+membership+docauth) =="
echo -n "set_verifier: "; inv $DR set_verifier --verifier $V
echo -n "set_image_id(seal): "; inv $DR set_image_id --seal_image_id $SEAL
echo -n "set_membership_image_id: "; inv $DR set_membership_image_id --membership_image_id $MEMBERSHIP
echo -n "set_docauth_image_id: "; inv $DR set_docauth_image_id --docauth_image_id $DOCAUTH
echo "== DONE =="
