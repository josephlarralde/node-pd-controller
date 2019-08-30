const Pd = require('../');
const path = require('path');

// initialize Pd with the `bin` path of pure data
// (where the `pd`, `pdsend`, and `pdreceive` binaries are located)

Pd.init('/Applications/Pd-0.49-1-x86_64.app/Contents/Resources/bin', { useUdp: true })
.then(() => {
  console.log('doing the patching stuff');
  const myPatch = Pd.open(path.join(__dirname, 'hello-increment')); // patch name without '.pd' extension
  myPatch.on('message', (msg) => {
      console.log(`pure data says ${msg}`);
  });
  myPatch.send('hello', 1);

  // the udp message fires before the patch is actually opened,
  // so we need a timeout here :
  setTimeout(() => { myPatch.sendUdp('hello', 2); }, 10);
  // myPatch.sendUdp('hello', 2);

  setTimeout(() => {
    Pd.close(myPatch);
  }, 5000);
});
