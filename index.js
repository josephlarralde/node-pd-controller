const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const wrapperBegin = `
#N canvas 0 23 450 300 10;
#X obj 10 10 r __to_pd__;
`;

const wrapperEnd = `
#X obj 10 110 list trim;
#X obj 10 130 s __from_pd__;
#X connect 0 0 1 0;
#X connect 1 0 2 0;
#X connect 2 0 3 0;
#X connect 3 0 4 0;
#X connect 4 0 5 0;
`;

////////// PURE DATA PATCH WRAPPER CLASS //////////

class Patch extends EventEmitter {
  constructor(id, pdsend) {
    super();

    this.id = id;
    this.pdsend = pdsend;
  }

  send(...args) {
    let sendString = `send ${this.id}`;
    args.forEach((arg) => { sendString += ` ${arg}`; });
    sendString += ';\n';
    this.pdsend.stdin.write(sendString);
  }
}

////////// PURE DATA MAIN WRAPPER CLASS //////////

class Pd {
  // constructor(binFolder, pdOptions = [], sendPort = 3030, receivePort = 3031, tmpDir = 'tmp') {
  static async init(binFolder, pdOptions = [], sendPort = 3030, receivePort = 3031, tmpDir = 'tmp') {
    this.binFolder = binFolder;
    this.pdOptions = pdOptions;
    this.sendPort = sendPort;
    this.receivePort = receivePort;
    this.pd = null;
    this.pdsend = null;
    this.pdreceive = null;
    this.patches = {};
    this.tmpDir = path.join(__dirname, tmpDir);
    this.uuid = 0;

    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir);
    }

    const files = fs.readdirSync(this.tmpDir);
    files.forEach((file) => { fs.unlinkSync(path.join(this.tmpDir, file)); });

    await this.start();
  }

  static async start() {
    return new Promise(async (resolve, reject) => {
      await this._start();

      //////////////////// PDSEND PROCESS

      this.pdsend = spawn(path.join(this.binFolder, 'pdsend'), [`${this.sendPort}`]);
      resolve();
    });
  }

  static async _start() {
    return new Promise(async (resolve, reject) => {
      await this._kill('pdsend');
      await this._kill('pd');
      await this._kill('pdreceive');

      //////////////////// PDRECEIVE PROCESS

      this.pdreceive = spawn(path.join(this.binFolder, 'pdreceive'), [`${this.receivePort}`]);

      this.pdreceive.stdout.on('data', (data) => {
        if (`${data}` === 'initialized;\n') {
          resolve();
        } else {
          this._routeMessage(data);
        }
      });

      this.pdreceive.stderr.on('data', async (data) => {
        console.log(`pdreceive stderr : ${data}`);
        await this._sleep(5000);
        this.start().then(() => { resolve(); });
      });

      //////////////////// PD PROCESS

      const _netsendPath = path.join(__dirname, '_pd-netsend');
      const _netreceivePath = path.join(__dirname, '_pd-netreceive');

      const netsendPath = this._createSendReceiveWrapper(_netsendPath, 'sender', `${this.receivePort}`);
      const netreceivePath = this._createSendReceiveWrapper(_netreceivePath, 'receiver', `${this.sendPort}`);

      const options = this.pdOptions.concat([
        '-nogui', '-noprefs',
        '-open', `${netsendPath}`, `${netreceivePath}`,
      ]);

      this.pd = spawn(path.join(this.binFolder, 'pd'), options);

      // print console output (yes, pd's console output goes to stderr !)
      this.pd.stderr.on('data', (data) => { console.log(`pd : ${data}`); });
    });
  }

  static open(patchPath, ...args) {
    const id = this.uuid; // `id-${Date.now()}`;
    this.uuid++;
    
    const fullPath = this._createPatchWrapper(patchPath, id, ...args);
    const filedir = path.dirname(fullPath);
    const filename = path.basename(fullPath);
    this.patches[id] = new Patch(id, this.pdsend);
    this.pdsend.stdin.write(`open ${filename} ${filedir};\n`);

    return this.patches[id];
  }

  static close(patch) {
    const id = patch.id;
    this.pdsend.stdin.write(`close ${id}.pd;\n`);
  }

  static _routeMessage(msg) {
    let msgs = `${msg}`.split(';\n').map(atoms => atoms.split(' '));

    msgs.forEach((atoms) => {
      const id = atoms.splice(0, 1)[0];
      if (this.patches[id]) {
        this.patches[id].emit('message', atoms);
      }
    });
  }

  static _createSendReceiveWrapper(originalPatchPath, id, arg) {
    let patchContents = '#N canvas 50 50 400 300 10;\n#X obj 10 10';
    patchContents += ` ${originalPatchPath} ${arg};`;

    return this._createWrapperFile(id, patchContents);
  }

  static _createPatchWrapper(originalPatchPath, id, ...args) {
    let patchContents = wrapperBegin;

    patchContents += `#X obj 10 30 route ${id};\n`
    patchContents += `#X obj 10 50 ${originalPatchPath} ${id}`;
    args.forEach((arg) => { patchContents += ` ${arg}`; });
    patchContents += ';\n';
    patchContents += `#X obj 10 90 list prepend ${id};`;

    patchContents += wrapperEnd;

    return this._createWrapperFile(id, patchContents);
  }

  static _createWrapperFile(id, contents) {
    const patchPath = path.join(this.tmpDir, `${id}.pd`);
    fs.writeFileSync(patchPath, contents);
    return patchPath;
  }

  static _deleteWrapperFile(id) {
    const patchPath = path.join(__dirname, this.tmpDir, `${id}.pd`);
    fs.unlinkSync(patchPath);
  }

  static  async _kill(procName) {
    return new Promise((resolve, reject) => {
      const e = exec(`killall ${procName}`);
      e.on('exit', () => { resolve(); });
    });
  }

  static  async _sleep(duration) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, duration);
    })
  }
}

module.exports = Pd;