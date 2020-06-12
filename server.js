const dgram = require('dgram');
const server = dgram.createSocket('udp4');
const v8 = require('v8');
const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

let cache = {};

if (fs.existsSync('./dump')) {
    let buf = fs.readFileSync('./dump');
    cache = v8.deserialize(buf);
}

server.on("message", async (localReq, lInfo) => {
    let request = parseDNSPackage(localReq);
    let question = request.Questions[0];
    let name = question.domainName;
    let response;
    let dataToCache = {};
    if (cache.hasOwnProperty(name)) {
        let answers = [];
        for (let i = 0; i < cache[name].length; i++) {
            if (cache[name][i].type === question.type && Date.now() < cache[name][i].expireIn) {
                answers.push(cache[name][i].resourseRecord);
            }
        }
        if (answers.length !== 0){
            let responseFields = {
                ID: request.ID,
                QR: true,
                OPCODE: request.OPCODE,
                AA: request.AA,
                TC: false,
                RD: request.RD,
                RA: true,
                Z: request.Z,
                QDCOUNT: request.QDCOUNT,
                ANCOUNT: answers.length,
                NSCOUNT: 0,
                ARCOUNT: 0,
                Questions: request.Questions,
                Answers: answers
             }
            response = getComposedDNSPackage(responseFields);
        }
        else {
            response = await getResponsFromUpstreamServer(localReq, '8.8.8.8');
            dataToCache['buffer'] = response;
        }
    }
    else {
        response = await getResponsFromUpstreamServer(localReq, '8.8.8.8');
        dataToCache['buffer'] = response;
    }
    server.send(response, lInfo.port, lInfo.address);
    updateCache(dataToCache);
});

server.bind(53, 'localhost');

server.on('listening',  () => { 
    console.log(`Сервер запущен на ${server.address().address}:${server.address().port}`);
    rl.question('Ведите "stop" для завершения работы сервера\n', (answer) => {    
        if (answer == 'stop') {
            server.close();
            let buf = v8.serialize(cache);
            fs.writeFileSync('./dump', buf);
            process.exit();
        }
      });
});

function updateCache(dataToCache) {
    for (let name in cache) {
        for (let i = 0; i < cache[name].length; i++) {
            if (Date.now() >= cache[name][i].expireIn) {
                cache[name].splice(i, 1)
                i--;
            }
        }
        if (cache[name].length === 0)
            delete cache[name];
    }
    if (!isEmpty(dataToCache)) {
        let parsedData = parseDNSPackage(dataToCache.buffer);
        for (let i = 0; i < parsedData.Answers.length; i++) {
            if (!cache.hasOwnProperty(parsedData.Answers[i].domainName)) {
                cache[parsedData.Answers[i].domainName] = []; 
            }
            cache[parsedData.Answers[i].domainName].push({
                type: parsedData.Answers[i].type,
                expireIn: Date.now() + (parsedData.Answers[i].ttl * 1000),
                resourseRecord: parsedData.Answers[i]
            });
        }
    }
}

function parseDNSPackage(buffer) {
    let fields = {};

    fields['ID'] = buffer.readUInt16BE(0);

    let byte2 = buffer.readUInt8(2);
    fields['QR'] = !!(byte2 & 0b10000000); // Q if false, R if true
    fields['OPCODE'] = (byte2 & 0b01111000) >>> 3
    fields['AA'] = !!(byte2 & 0b00000100);
    fields['TC'] = !!(byte2 & 0b00000010);
    fields['RD'] = !!(byte2 & 0b00000001);

    let byte3 = buffer.readUInt8(3);
    fields['RA'] = !!(byte3 & 0b10000000);
    fields['Z'] = (byte3 & 0b01110000) >>> 4;
    fields['RCODE'] = (byte3 & 0b00001111);
    
    fields['QDCOUNT'] = buffer.readUInt16BE(4);
    fields['ANCOUNT'] = buffer.readUInt16BE(6);
    fields['NSCOUNT'] = buffer.readUInt16BE(8);
    fields['ARCOUNT'] = buffer.readUInt16BE(10);

    let currentByteIndex = 12;
    fields['Questions'] = [];
    let objEndOffset = { EndOffset: 0 };
    for (let qCount = 0; qCount < fields.QDCOUNT; qCount++) {
        currentByteIndex += objEndOffset.EndOffset;
        let qResourseRecord = parseResourseRecord(buffer, currentByteIndex, objEndOffset, true);
        fields.Questions.push(qResourseRecord);
    }
    currentByteIndex = objEndOffset.EndOffset;
    readNonQuestionReqcords('Answers', 'ANCOUNT');
    readNonQuestionReqcords('Authorities', 'NSCOUNT');
    readNonQuestionReqcords('Additionals', 'ARCOUNT');

    return fields;

    function readNonQuestionReqcords(nameOfProperty, lengthProperty) {
        fields[nameOfProperty] = [];
        for (let pCount = 0; pCount < fields[lengthProperty]; pCount++) {
            currentByteIndex = objEndOffset.EndOffset;
            let resourseRecord = parseResourseRecord(buffer, currentByteIndex, objEndOffset, false);
            fields[nameOfProperty].push(resourseRecord);
        }
    }
}

function parseResourseRecord(buffer, startOffset, objEndOffset = {}, isQuestion) {
    let currentByteIndex = startOffset;
    objEndOffset['EndOffset'] = currentByteIndex;
    let resourseRecord = {};

    let nameEndIndexObj = { EndOffset: undefined };
    let domain = readDomainName(buffer, currentByteIndex, nameEndIndexObj);
    currentByteIndex = nameEndIndexObj.EndOffset + 1;
    resourseRecord['domainName'] = domain;

    resourseRecord['type'] = buffer.readUInt16BE(currentByteIndex);
    currentByteIndex += 2;

    resourseRecord['class'] = buffer.readUInt16BE(currentByteIndex);
    currentByteIndex += 2;

    if (!isQuestion) {
        resourseRecord['ttl'] = buffer.readUInt32BE(currentByteIndex);
        currentByteIndex += 4;

        resourseRecord['rdlength'] = buffer.readUInt16BE(currentByteIndex);
        currentByteIndex += 2;

        let tempBuffer = buffer.subarray(currentByteIndex, currentByteIndex + resourseRecord.rdlength);
        resourseRecord['rdata'] = Buffer.alloc(resourseRecord.rdlength, tempBuffer);
        currentByteIndex += resourseRecord.rdlength;
    }
    objEndOffset['EndOffset'] = currentByteIndex;
    return resourseRecord;
}

function readDomainName(buffer, startOffset, objEndOffset = {}) {
    let currentByteIndex = startOffset;
    initOctet = buffer.readUInt8(currentByteIndex);
    objEndOffset['EndOffset'] = currentByteIndex;
    let domain = '';
    
    let lengthOctet = initOctet;
    while (lengthOctet > 0) {
        let label;
        if (lengthOctet >= 192) { //then domain name is compressed
            let pointer = buffer.readUInt16BE(currentByteIndex) - 0b1100000000000000;
            let returnValue = {};
            label = readDomainName(buffer, pointer, returnValue);
            domain += ('.' + label);
            objEndOffset['EndOffset'] = currentByteIndex + 1;
            break;
        }
        else {
            currentByteIndex++;
            label = buffer.toString('ascii', currentByteIndex, currentByteIndex + lengthOctet);
            domain += ('.' + label);
            currentByteIndex += lengthOctet;
            lengthOctet = buffer.readUInt8(currentByteIndex);
            objEndOffset['EndOffset'] = currentByteIndex;
        }
    }
    return domain.substring(1);
}

async function getResponsFromUpstreamServer(request, upstreamServerAddress) {
    let client = dgram.createSocket('udp4');

    client.on('err', function(e) { throw e; });

    let promise = new Promise((resolve, reject) => {
        client.on('message', function (msg, rinfo) { 
            client.close();
            resolve(msg);
        });
        client.send(request, 53, upstreamServerAddress, function(err, bytes) {});
    }).then((msg) => { return msg });
    return promise;
}

function getComposedDNSPackage(fields){
    let buffer = Buffer.alloc(512);
    let currentByteIndex = 0;

    buffer.writeUInt16BE(fields.ID, currentByteIndex);
    currentByteIndex += 2;

    let byte2 = 0b00000000;
    if (fields.QR) {
        byte2 = 0b10000000;
    }
    byte2 = byte2 | (fields.PCODE << 3);
    if (fields.AA) {
        byte2 = byte2 | 0b00000100;
    }
    if (fields.TC) {
        byte2 = byte2 | 0b00000010;
    }
    if (fields.RD) {
        byte2 = byte2 | 0b00000001;
    }
    buffer.writeUInt8(byte2, currentByteIndex);
    currentByteIndex++;

    let byte3 = 0b00000000;
    if (fields.RA){
        byte3 = byte3 | 0b10000000;
    }
    byte3 = byte3 | (fields.Z << 4);
    byte3 = byte3 | fields.RCODE;
    buffer.writeUInt8(byte3, currentByteIndex);
    currentByteIndex++;

    buffer.writeUInt16BE(fields.QDCOUNT, currentByteIndex);
    currentByteIndex += 2;

    buffer.writeUInt16BE(fields.ANCOUNT, currentByteIndex);
    currentByteIndex += 2;

    buffer.writeUInt16BE(fields.NSCOUNT, currentByteIndex);
    currentByteIndex += 2;

    buffer.writeUInt16BE(fields.ARCOUNT, currentByteIndex);
    currentByteIndex += 2;

    fields.Questions.forEach(question => {
        let labels = question.domainName.split('.');
        labels.forEach(label => {
            let labelLength = label.length;
            buffer.writeUInt8(labelLength, currentByteIndex);
            currentByteIndex++;
            buffer.write(label, currentByteIndex, labelLength, 'ascii');
            currentByteIndex += labelLength;
        });
        buffer.writeUInt8(0, currentByteIndex);
        currentByteIndex++;
        buffer.writeUInt16BE(question.type, currentByteIndex);
        currentByteIndex += 2;
        buffer.writeUInt16BE(question.class, currentByteIndex);
        currentByteIndex += 2;
    });

    ['Answers', 'Authorities', 'Additionals'].forEach((section, i, arr) => {
        if (fields[section]) {
            fields[section].forEach(sectionItem => {
                let labels = sectionItem.domainName.split('.');
                labels.forEach(label => {
                    let labelLength = label.length;
                    buffer.writeUInt8(labelLength, currentByteIndex);
                    currentByteIndex++;
                    buffer.write(label, currentByteIndex, labelLength, 'ascii');
                    currentByteIndex += labelLength;
                });
                buffer.writeUInt8(0, currentByteIndex);
                currentByteIndex++;
                buffer.writeUInt16BE(sectionItem.type, currentByteIndex);
                currentByteIndex += 2;
                buffer.writeInt16BE(sectionItem, currentByteIndex);
                currentByteIndex += 2;
                buffer.writeInt32BE(sectionItem.ttl, currentByteIndex);
                currentByteIndex += 4;
                buffer.writeUInt16BE(sectionItem.rdlength, currentByteIndex);
                currentByteIndex += 2;
                sectionItem.rdata.copy(buffer, currentByteIndex, 0, sectionItem.rdata.length);
                currentByteIndex += sectionItem.rdata.length;
            });
        }
    });
    return buffer;
}

function isEmpty(object) {
	for (var key in object)
	    if (object.hasOwnProperty(key)) 
			return false;
	return true;
}
