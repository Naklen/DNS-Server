const dgram = require('dgram');
const server = dgram.createSocket('udp4');
(function() { 
    server.on("message", async (localReq, lInfo) => {
        //let q = parseDNSPackage(localReq);
        let response = await getResponsFromUpstreamServer(localReq, '8.8.8.8');
        server.send(response, lInfo.port, lInfo.address);
    });
    server.bind(53, 'localhost');

    server.on('listening', async () => { 
        console.log(`Сервер запущен на ${server.address().address}:${server.address().port}`)});           
}());

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
    objEndOffset['EndOffset'] = 0;
    readNonQuestionReqcords('Answers', 'ANCOUNT');
    objEndOffset['EndOffset'] = 0;
    readNonQuestionReqcords('Authorities', 'NSCOUNT');
    objEndOffset['EndOffset'] = 0;
    readNonQuestionReqcords('Additionals', 'ARCOUNT');

    return fields;

    function readNonQuestionReqcords(nameOfProperty, lengthProperty) {
        fields[nameOfProperty] = [];
        for (let pCount = 0; pCount < fields[lengthProperty]; pCount++) {
            currentByteIndex += objEndOffset.EndOffset;
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