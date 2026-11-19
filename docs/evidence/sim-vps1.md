# BTQ Swap simulation vps1

- Started: 2026-11-12T14:33:39.626Z · duration 454s · **ALL PASSED**
- BTQ regtest · EVM chain 31337 · HtlcERC20 0x6a8B5F431f6025D3349cc929185f2Abacb055732
- Discord interactions executed through the bot pipeline: 287

| Scenario | Result | Checks | Swaps | Time |
|---|---|---|---|---|
| buy-from-mm | ✅ pass | 5/5 | #4 completed | 44s |
| sell-to-mm | ✅ pass | 3/3 | #6 completed | 25s |
| p2p | ✅ pass | 5/5 | #7 completed | 30s |
| partial-fill | ✅ pass | 4/4 | #8 completed, #9 completed | 33s |
| burst | ✅ pass | 1/1 | #10 completed, #11 completed, #15 completed, #14 completed, #13 completed, #12 completed | 47s |
| buyer-no-show | ✅ pass | 3/3 | #2 expired | 205s |
| seller-no-show | ✅ pass | 4/4 | #1 refunded | 448s |
| buyer-never-claims | ✅ pass | 4/4 | #3 refunded | 454s |
| security | ✅ pass | 12/12 | #5 completed | 54s |

## Swaps and on-chain transactions

| Swap | Parties | Final | EVM lock | EVM claim/refund | BTQ lock | BTQ claim/refund | Preimage |
|---|---|---|---|---|---|---|---|
| #4 | alice=buyer, MM=seller | completed | 0x65388ff8f167e845dfe59e6b4cd3c4512c48ee0b51189df7f1dca8fce17e36b4 | 0x9f9b92bbc5bb8590bf2b23a722fbd3c1c707c45c7fe1b4b1150b311a34767425 | 5f3a0aadaf4dc53756d8424e733c9b538581a1944f4a0ca5f5e797516f16c68b | 443b84c839997dacbba6c35c5546271d7c7e1232f731aea9bb5b371fac4212f3 | a9d41b06e812e2ab299e44047d6b2d11dcf122d055a506f4b00985323b457230 |
| #6 | MM=buyer, bob=seller | completed | 0x85c453204b045bc0d8fcb2620c231c30b25e45dbb8c050cfdb03a3eb89a151c1 | 0x159f02f5bbd6f4055a7d84c1a5c1e2b33a7ec30ea3e1203f834a4c16dddd116f | 686bae4106518a0183375fce85ae9a77c806ef9fc25b8defbd649bfd0420ed53 | 78f1890ae2fa4c4d72df5b64a32c793ce4286b756bd482f005d92d6016b3874b | 31ec850df19ab4227f347d8673110d6eb595885d15a6be9ef0a3e8b18131e431 |
| #7 | dave=buyer, carol=seller | completed | 0x83f9b9edc1f33823547673df6178129ce3f0c65bc2e9a10e4446b94c63c6424a | 0x16e4902ec8d4e6c341377bb4f9db75efd9d47ea0a9a28bbf4e9dbec44a80f402 | 7c983f61d287047d593de9fc95dcb82e1a614f6d1b3b7b19e7eee087a069b96c | 36bae2c27cccf0f19e3d2262d0bb88f73abd0ea29012716f8aad735f393535bf | a322fafb868badd4b09e24f1b9163286bd74ada183d31a44134b14b2fce88243 |
| #8 | erin=buyer, frank=seller | completed | 0x938b475e683d010f509c42556500a6ad13143c214f065952be8386884646ce83 | 0x6e30e82a0153aabe76f21e7c6bc2f955761a4c9ec0e42132cdaa9acc43598a40 | 15c42b35bbff884ffd9f86b10d44fab28504c015e2e5510427c7d7e14be794ba | 71b00fe0e44bb3345fbe384f34d985ca0e11b33b9a2b3e8d0bdeb55eb9b15a11 | 29eb85576a916871c16326f22db0076a8aac825b5cd18e4d9b7d4f1180cab908 |
| #9 | erin=buyer, MM=seller | completed | 0x5ea039a9cdf3ad0e5e7dc2da396ab9ed6e3eb1514b05d76e56bfc2f73a3326e7 | 0x49b67fdaa8a0c6a357b98b02455876733d93192afc5e9ec098b94014cc0eb328 | 7e766561f52d9658cc6950e0c43ddaeb8b292e874788c40bd12f49969f6c7a65 | a571b9e490fc619d367a42f43a9bfbac538c9042c35c045347e4705c7f025609 | ea773522e5821ab923583f25283342bfb89fe709ac2cb087913bc7797a4786f9 |
| #10 | burst1=buyer, MM | completed | 0x3b477eb24d27d0ced2ef16ad8f0ce52377d91f0776a232a04f26963800786113 | 0x5637f6c0c610751f85912f95acec601b68de5c92caa38e2c4ea6a49730a3fa8d | 0e2e5708ad0fb225a6aed2e97120dd786888fc840043b9de549d71bcc3bb6ad6 | 33e778ecc7cfa438e8c4d9e81da38d5d6b923d80882c08258c8575079d8bd8ba | 19bfb91f86a0e7f0ce17ea6acc08509aba4258ae408c32bf78767b9b2ac38216 |
| #11 | burst2=seller, MM | completed | 0x293ee39bd8f1ce7eba24b1007f4f755b3400c0b25958f726121c4e352dab8e2d | 0xf418192f1d935a34451fa99c0742a7a5c0d9d47810dd0365e555e4770016abd0 | 92173dc822c63834049f6af3e27491019cce9d70cdf6e66c86eafdafc82cf908 | 3b5b3cbb80a303472321a848f06173aeb2961bac172a7da5fb4f83ce959d284e | e2160abc095f2f08c6d958375f6ea91497245e0edeef7ce4e55aba380fec23a5 |
| #15 | burst3=buyer, MM | completed | 0xe82bd4d06546098a3d4f5c922d8b3c356db45f1f7160e8c283483976a96d6a4b | 0x3ffbc3f0d69e1c7fc31c6d16f04ed0a7c37027a14f8b2c47bcd9abedb9ae5084 | bcabffdf445f886f6864997244a43881b87cc7367aff23a4025b9d1f13e8b8b5 | 2642f29671984a0986757ba372cb2dba2b15bc259a2694dda13c2f21b697a930 | 9d5e0b9ab0c9b6eee10fc0c31ccbc9c46ccd203178e965f4311ea8cbc57c9b82 |
| #14 | burst4=seller, MM | completed | 0xfa0917b69e58fffc2e74d98d21fc02b24f3a0052af4995a360768d9e319d311b | 0x0adf3fb44d9afd0850e55d9708613bd9fd195ee209df486ab7fdda2b80641721 | 499b7ac391d797ea246996303267da041fe5dc9134620581313fc27887993d1d | 6d6854c61c65bbf0e40577fc03ae0cfe783866a26db30167ee2b2b1f208f17e9 | b87c8af11823fe22440cbd66c9b695555917e863515f3ba6ba340180b79cc7f6 |
| #13 | burst5=buyer, MM | completed | 0xa0ce2cdcbdb630e823be5fa1143464e6eef7bd1b54981e5e55a14a6c248f358e | 0xd154eeb4f2262cf62b19106c7f7cec6867382ee9414ff06aa8f375cf4f38a752 | f7c8ba2c72db615337c688b8b82b385cad81052c48e37058af4a2dc270e5cd3c | 5eef1b021d8c7f4c34496994280df984d6621be215c1ad1ee3cde4e1c6d926e4 | 1fe459edca01b1ba50be939ed7695321142f591949afc00a5728e97a4a8ad4b0 |
| #12 | burst6=seller, MM | completed | 0x26a08c0e04487aae68d579fe1e9a684d5444b4cdae530c72cce0cd2aaea62cb2 | 0xe32594c2d09e5d5439a7711f78223c508fd9d7fea71f906489a651cb6cf40748 | de4497861b55d9664979735fc3ca96d93f0f1d617c22d0d2f87783dbbffead8e | ce6dd6f967c4ade7a82d4178349339fe1b73e40eac66c1bf3a6c0d2e7009f25c | f737b2b10d80c3ac9edeb41b2a230edf44aee87c2a1aa7073201790fa81152bf |
| #2 | grace=buyer (no-show), MM=seller | expired | — | — | — | — | — |
| #1 | ivan=buyer (refunded), heidi=seller (no-show) | refunded | 0x8bdc4da435bd5a60df58b6aecb1fbb552c7ebb4e3602ac50f2020ba0215aa5e8 | 0xe9d92370a073f759a0ed820025637f9f3f6cdec8954303bfa429c01e44152caf | — | — | — |
| #3 | judy=buyer (never claimed), MM=seller | refunded | 0x9118587c9f5a3938c868aee04b5f5369d1ccc738fb0e670812baa1178c014633 | 0x46c25aa6348f5fcfc68cefbb44caa671051e64a429ad30944fb51556f88dc2fc | 5af64beba6f563383f1f25c2abf3e914def6a8164042ff59c8e77a8df13839e0 | 5f3f77568581e026e92e0c49edf5951b89b3a7d1d2b32b0e09a0aab205e3efa0 | — |
| #5 | kevin=buyer (after a rejected lock), MM=seller | completed | 0xa118957d8acd4b9dc501ef9b64bca2cb1d6f2f35a150b6095ad62c6972e5b800 | 0x4cd278ff4c72d51eb656051c616427971c34096b24e2bc46ef7cdf9939d7ea13 | e597dcc9cba248575dd6b4908d75c58dd75ccfa011ad553e0e99b7af1873e4cb | f1515affc7c263bc6978ca10b90b597556bf3b85b9150a6f8b4e4ef70b725401 | 2233514b12db905d0cf2f65779ccb0740f0ae253ee3340feed0a261eedee675d |

## Checks

### buy-from-mm
- ✅ market buy matched exactly one swap — swaps 4
- ✅ swap completed
- ✅ alice paid exactly the quoted USDT — 5100000 vs 5100000
- ✅ alice received 2 BTQ minus the claim fee — 199999354 sats
- ✅ preimage revealed on BTQ chain matches the hash locked on EVM

### sell-to-mm
- ✅ market sell matched one swap
- ✅ bob received exactly the quoted USDT — 7350000 vs 7350000
- ✅ bob paid 3 BTQ plus the wallet fee — 300002880

### p2p
- ✅ carol order rests on the book (no cross) — order 11
- ✅ dave took carol order into one swap
- ✅ price is the resting order price — 3900000
- ✅ dave paid USDT to carol
- ✅ dave received ~1.5 BTQ from carol

### partial-fill
- ✅ frank ask rests
- ✅ erin market buy split into two swaps — 8,9
- ✅ best price filled first (frank @ 2.52) — 8
- ✅ both swaps completed

### burst
- ✅ all 6 concurrent swaps completed

### buyer-no-show
- ✅ take created a swap
- ✅ no EVM lock and no BTQ lock exist
- ✅ grace balances unchanged

### seller-no-show
- ✅ seller window passed → buyer refund pending
- ✅ /swap refund shows the refund command
- ✅ ivan got all USDT back — 0
- ✅ heidi BTQ untouched

### buyer-never-claims
- ✅ BTQ timelock reached without a claim
- ✅ MM refunded its BTQ via the CLTV leaf — 5f3f77568581e026e92e0c49edf5951b89b3a7d1d2b32b0e09a0aab205e3efa0
- ✅ judy USDT fully refunded
- ✅ judy never received BTQ

### security
- ✅ unregistered (no ToS) user cannot trade
- ✅ ToS-only user without wallet links cannot trade
- ✅ clicking another user's button is FORBIDDEN
- ✅ forged cancel with victim id → FORBIDDEN
- ✅ cancel of another user's order → NOT_FOUND
- ✅ owner can cancel
- ✅ underpaid USDT lock rejected — amount 2549999 < required 2550000
- ✅ swap still waits for a valid lock
- ✅ corrected swap completed
- ✅ banned user is refused
- ✅ non-admin /swap-admin → FORBIDDEN
- ✅ rate limit kicks in after 20 interactions/min — 10 limited
