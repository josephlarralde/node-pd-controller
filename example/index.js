const Pd = require('../');
const path = require('path');

// initialize Pd with the `bin` path of pure data
// (where the `pd`, `pdsend`, and `pdreceive` binaries are located)

Pd.init('/Applications/Pd-0.49-1-x86_64.app/Contents/Resources/bin')
.then(() => {
    const myPatch = Pd.open(path.join(__dirname, 'hello-increment')); // patch name without '.pd' extension
    myPatch.on('message', (msg) => {
        console.log(`pure data says ${msg}`);
    });
    myPatch.send('hello', 1);
    Pd.close(myPatch);
});
