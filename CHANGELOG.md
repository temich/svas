## [2.0.1](https://github.com/temich/svas/compare/v2.0.0...v2.0.1) (2026-09-05)


### Bug Fixes

* **package:** the svelte peer range says which major it is ([e17b1be](https://github.com/temich/svas/commit/e17b1be415b1257fe9e1ae712677b13cd96459e6))

# [2.0.0](https://github.com/temich/svas/compare/v1.7.1...v2.0.0) (2026-09-05)


* feat!: `sync` compares the system properties by their new names ([bc47bde](https://github.com/temich/svas/commit/bc47bdeb9a4401423cb118134306a5a5e6f0b9bf))


### BREAKING CHANGES

* an item passed to `sync` carries `VERSION` and `DELETED`
rather than `_version` and `_deleted`.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

## [1.7.1](https://github.com/temich/svas/compare/v1.7.0...v1.7.1) (2026-04-14)


### Bug Fixes

* **collection:** prevent concurrent intitial requests ([b8524cb](https://github.com/temich/svas/commit/b8524cb3a3f3c68c5c53d787137c06440d852465))

# [1.7.0](https://github.com/temich/svas/compare/v1.6.0...v1.7.0) (2026-04-09)


### Features

* **sync:** add `delete` option ([850157a](https://github.com/temich/svas/commit/850157afdac94feb8a150b11fa596870bf5356c7))

# [1.6.0](https://github.com/temich/svas/compare/v1.5.1...v1.6.0) (2026-03-23)


### Features

* add `get` to `value` ([2b97202](https://github.com/temich/svas/commit/2b9720296bbf0b2ccfab23f3372915993261b15c))

## [1.5.1](https://github.com/temich/svas/compare/v1.5.0...v1.5.1) (2026-03-13)


### Bug Fixes

* **collection:** set values on set ([7f32cdd](https://github.com/temich/svas/commit/7f32cdd5f844852973e3b86162442e103dcdc0cb))

# [1.5.0](https://github.com/temich/svas/compare/v1.4.0...v1.5.0) (2026-02-11)


### Features

* remove `class` prop ([ba6b17b](https://github.com/temich/svas/commit/ba6b17bbfb365b3ca7e691a68a680ae67f68952b))

# [1.4.0](https://github.com/temich/svas/compare/v1.3.0...v1.4.0) (2026-01-30)


### Features

* add reload button on error ([23dd2cf](https://github.com/temich/svas/commit/23dd2cfb485c21b98256cc0fd3fddc94dbb2b5b4))
* export `once` ([4ef66cf](https://github.com/temich/svas/commit/4ef66cf8686223bf67bcaa29b8a486227b8faee2))

# [1.3.0](https://github.com/temich/svas/compare/v1.2.1...v1.3.0) (2026-01-10)


### Features

* handle invalid storage values ([5538eb9](https://github.com/temich/svas/commit/5538eb9f6a892763fa459916178e1d4b45f0e079))

## [1.2.1](https://github.com/temich/svas/compare/v1.2.0...v1.2.1) (2026-01-09)


### Bug Fixes

* **combined:** fix reactivity ([729da48](https://github.com/temich/svas/commit/729da48b97aaf293388bb1a06de26726cbc0d44e))

# [1.2.0](https://github.com/temich/svas/compare/v1.1.0...v1.2.0) (2025-12-29)


### Features

* remove wrapping `<div>` from `<Async />` ([cdeffa7](https://github.com/temich/svas/commit/cdeffa7c32d2083f25351269bc82e9a604322cbc))

# [1.1.0](https://github.com/temich/svas/compare/v1.0.0...v1.1.0) (2025-12-26)


### Features

* swap sync arguments ([722aa85](https://github.com/temich/svas/commit/722aa855e3adc729a3882f58516a6e989d0e6b0f))

# 1.0.0 (2025-12-09)


### Bug Fixes

* **collection:** set error value on refresh ([67c7316](https://github.com/temich/svas/commit/67c7316d36d429e48f318e414e236472d6381781))
* fix import ([a616e13](https://github.com/temich/svas/commit/a616e13030773b01d3d22437a5c373602dd51d4c))
* **value:** apply `map` on update ([776b16e](https://github.com/temich/svas/commit/776b16edbea1c87f7008eda0aa026e642c7710fd))
* **value:** update `map` types ([0763446](https://github.com/temich/svas/commit/076344670c1c6d99d8995d98054f77dde9ff6638))
* **value:** use `default` when clearing bound ([b5e36ee](https://github.com/temich/svas/commit/b5e36eeceb90d2e8e3f00fcfedcfef4c3837aead))


### Features

* add `collection.fetch` ([b8e7b64](https://github.com/temich/svas/commit/b8e7b64e4ab030cbcc009b1cd99bdc4c8dc3c5c3))
* add implementation ([65d593b](https://github.com/temich/svas/commit/65d593bf460e118348880659bac8238ede809f0a))
* **collection:** add `update` options ([c5d775f](https://github.com/temich/svas/commit/c5d775f39047a822f53ecbc301f82cd2835ee907))
