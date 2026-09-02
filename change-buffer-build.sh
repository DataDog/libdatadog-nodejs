rm -f Cargo.lock
rm -rf prebuilds/*
npm run build-wasm
npx napi build --platform -p pipeline-native -o prebuilds/fastline --release