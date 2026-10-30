const { devices } = require('node-hid');
const VID = 0x3837, PID = 0x300a;
const list = devices().filter(d => d.vendorId === VID && d.productId === PID);
console.log(JSON.stringify(list, null, 2));
