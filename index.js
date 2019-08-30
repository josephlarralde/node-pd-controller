const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const osc = require('osc');
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

function isNumeric(x) { return (typeof x == 'number' && !isNaN(x)); }
function isInteger(x) { return (isNumeric(x) && Number.isInteger(x)); }

////////// PURE DATA PATCH WRAPPER CLASS //////////

class Patch extends EventEmitter {
  constructor(id, pd) {
    super();

    this.id = id;
    this.pd = pd;
  }

  send(...args) {
    let sendString = `send ${this.id}`;
    args.forEach((arg) => { sendString += ` ${arg}`; });
    sendString += ';\n';
    this.pd.pdsend.stdin.write(sendString);
  }

  sendUdp(...args) {
    if (!this.pd.useUdp) return;

    const typedArgs = [{ type: 's', value: this.id }];

    args.forEach((arg) => {
      let typedArg = { value: arg };
      if (isNumeric(arg)) {
        if (isInteger(args)) { typedArg.type = 'i'; }
        else { typedArg.type = 'f'; }
      } else if (typeof arg == 'string' ) {
        typedArg.type = 's';
      }
      typedArgs.push(typedArg);
    });

    this.pd.osc.send({ address: '/all', args: typedArgs });
  }
}

const defaultPdParameters = {
  pdOptions: [],
  useUdp: false,
  pdsendPort: 3030,
  pdreceivePort: 3031,
  udpsendPort: 8000,
  udpreceivePort: 8001,
  tmpDir: 'tmp',
};

////////// PURE DATA MAIN WRAPPER CLASS //////////

class Pd {
  static async init(binFolder, opts = {}) {
    const {
      pdOptions,
      useUdp,
      pdsendPort,
      pdreceivePort,
      udpsendPort,
      udpreceivePort,
      tmpDir
    } = Object.assign(defaultPdParameters, opts);

    this.binFolder = binFolder;
    this.pdOptions = pdOptions;

    this.pdsendPort = pdsendPort;
    this.pdreceivePort = pdreceivePort;

    this.useUdp = useUdp;
    this.udpsendPort = udpsendPort;
    this.udpreceivePort = udpreceivePort;
    this.osc = null;

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
      this._start()
      .then(() => {
        //////////////////// PDSEND PROCESS
        this.pdsend = spawn(path.join(this.binFolder, 'pdsend'), [`${this.pdsendPort}`]);
        resolve();
      }, async () => {
        await this._kill('pdsend');
        await this._kill('pd');
        await this._kill('pdreceive');

        if (this.osc !== null) {
          this.osc.close();
          delete this.osc;
          this.osc = null;
        }

        await this._sleep(5000);
        await this.start();
        resolve();
      });
    });
  }

  static async _start() {
    if (this.useUdp) {
      await this._startUdp();
    }

    await this._startPdReceive();
  }

  /**
   * Start osc udp class to send udp messages to pd
   * (and check for recurring EADDRINUSE errors)
   */
  static async _startUdp() {
    return new Promise((resolve, reject) => {
      this.osc = new osc.UDPPort({
        localAddress: '0.0.0.0',
        localPort: this.udpreceivePort,
        remoteAddress: '127.0.0.1',
        remotePort: this.udpsendPort,
      });

      // todo (backwards udp communication) :
      // this.osc.on('bundle', (oscBundle, timeTag, info) => {});
      this.osc.on('ready', () => { console.log('udp ready'); resolve(); });
      this.osc.on('error', (err) => { console.log('udp error'); reject(); });
      this.osc.open();
    });
  }

  /**
   * Start pd process
   */
  static _startPd() {
    const _netsendPath = path.join(__dirname, '_pd-netsend');
    const _netreceivePath = path.join(__dirname, '_pd-netreceive');

    const netsendPath = this._createSendReceiveWrapper(_netsendPath, 'sender', `${this.pdreceivePort}`);
    const netreceivePath = this._createSendReceiveWrapper(_netreceivePath, 'receiver', `${this.pdsendPort}`, `${this.udpsendPort}`);

    const options = this.pdOptions.concat([
      '-nogui', '-noprefs',
      '-open', `${netsendPath}`, `${netreceivePath}`,
    ]);

    this.pd = spawn(path.join(this.binFolder, 'pd'), options);
    // print console output (yes, pd's console output goes to stderr !)
    this.pd.stderr.on('data', (data) => { console.log(`pd : ${data}`); });
  }

  /**
   * Start pdsend binary
   */
  static _startPdSend() {
    this.pdsend = spawn(path.join(this.binFolder, 'pdsend'), [`${this.pdsendPort}`]);    
  }

  /**
   * Start pdreceive binary
   * (and check for recurrent "Address already in use" errors)
   */
  static async _startPdReceive() {
    return new Promise((resolve, reject) => {
      console.log('spawning pdreceive');
      this.pdreceive = spawn(path.join(this.binFolder, 'pdreceive'), [`${this.pdreceivePort}`]);

      this.pdreceive.stdout.on('data', (data) => {
        if (`${data}` === 'initialized;\n') {
          console.log('pdreceive ready');
          resolve();
        } else {
          this._routeMessage(data);
        }
      });

      this.pdreceive.stderr.on('data', async (data) => {
        console.log(`pdreceive stderr : ${data}`);
        reject();
      });

      this._startPd();
    });
  }

  /**
   * Open a patch
   * todo : make async and resolve on patch loaded acknowledgement ?
   * (early udp messages are missed because sent too fast)
   */
  static open(patchPath, ...args) {
    const id = `id-${this.uuid}`; // `id-${Date.now()}`;
    this.uuid++;

    const fullPath = this._createPatchWrapper(patchPath, id, ...args);
    const filedir = path.dirname(fullPath);
    const filename = path.basename(fullPath);
    // this.patches[id] = new Patch(id, this.pdsend);
    this.patches[id] = new Patch(id, this);
    this.pdsend.stdin.write(`open ${filename} ${filedir};\n`);
    this.on('message')

    return this.patches[id];
  }

  /**
   * Close a patch
   */
  static close(patch) {
    const id = patch.id;
    this.pdsend.stdin.write(`close ${id}.pd;\n`);
  }

  ////////// PRIVATE METHODS

  static _routeMessage(msg) {
    let msgs = `${msg}`.split(';\n').map(atoms => atoms.split(' '));

    msgs.forEach((atoms) => {
      const id = atoms.splice(0, 1)[0];
      if (this.patches[id]) {
        this.patches[id].emit('message', atoms);
      }
    });
  }

  static _createSendReceiveWrapper(originalPatchPath, id, ...args) {
    let patchContents = '#N canvas 50 50 400 300 10;\n#X obj 10 10';
    patchContents += ` ${originalPatchPath}`;
    args.forEach((arg) => { patchContents += ` ${arg}`; });

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

  static async _kill(procName) {
    return new Promise((resolve, reject) => {
      const e = exec(`killall ${procName}`);
      e.on('exit', () => { resolve(); });
    });
  }

  static async _sleep(duration) {
    return new Promise((resolve, reject) => {
      setTimeout(() => { resolve(); }, duration);
    });
  }
}

module.exports = Pd;