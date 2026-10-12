# cre

Status: rencana. Belum ada kode (backlog B3.2, Fase 3, bounty B11).

## Tujuan

Workflow Chainlink CRE "City Guardian" (peran Satpam): memantau kota dan, bila risiko di atas ambang, melaporkan ke kontrak `CityGuardian` agar dana dievakuasi dari adapter ke idle.

## Rencana

1. Pemicu: cron tiap 10 menit, ditambah event `Rebalanced` dan `Deposit` dari vault.
2. Baca fee dan yield dari DefiLlama (HTTP), lalu saldo vault dan adapter (EVM read).
3. Panggil LLM untuk mengklasifikasi risiko dan menyusun alasan, dengan output terstruktur.
4. Tulis laporan `(city, action, adapter, planHash)` ke `CityGuardian` lewat forwarder CRE.

## Batas yang diketahui

- Runtime QuickJS tanpa Node API; maksimal 15 HTTP call dan 15 EVM read per run.
- LLM hanya mengusulkan. Dana bergerak otomatis hanya lewat aturan deterministik di kontrak: adapter yang diizinkan, batas pergeseran, dan evakuasi hanya ke idle.
- Tanda tangan `onReport` dan cara validasi pengirim harus dibaca dari dokumentasi Chainlink saat B1.7, bukan ditebak.

## Belum diuji

Forwarder CRE ke kontrak buatan sendiri di Monad testnet belum pernah diuji siapa pun.
