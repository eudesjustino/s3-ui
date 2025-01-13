require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const util = require('util');
const multer = require('multer');
const { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand,ListObjectsV2Command,ListBucketsCommand,DeleteObjectCommand,DeleteBucketCommand,HeadBucketCommand,ListObjectVersionsCommand  } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const stream = require('stream');

const app = express();

// Lê region e endpoint de variáveis de ambiente
const REGION = process.env.AWS_REGION || 'us-east-1';
const ENDPOINT = process.env.AWS_ENDPOINT || 'http://localhost:4566';
const PORT = process.env.PORT || 4000;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test';
const AWS_SECRET_ACCESS_KEY =  process.env.AWS_SECRET_ACCESS_KEY || 'test';

// Configuração do AWS SDK para apontar para o LocalStack
const s3Client = new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true, // Necessário para o LocalStack
});

// Middleware para tratar uploads multipart/form-data
const upload = multer();

/************************************************************************
 * MIDDLEWARES
 ************************************************************************/
app.use(cors());
app.use(bodyParser.json());

// Servir arquivos estáticos (HTML, CSS, JS) a partir da pasta /public
app.use(express.static(path.join(__dirname, 'public')));


// Rota para criar um bucket
app.post('/create-bucket', express.json(), async (req, res) => {
    const { bucketName } = req.body;

    if (!bucketName) {
        return res.status(400).json({ error: 'O nome do bucket é obrigatório.' });
    }

    try {
        const command = new CreateBucketCommand({ Bucket: bucketName });
        await s3Client.send(command);
        res.status(201).json({ message: `Bucket '${bucketName}' criado com sucesso.` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao criar o bucket.' });
    }
});

// Função auxiliar para esvaziar um bucket
async function emptyBucket(bucketName) {
    // Listar todas as versões dos objetos (se o versionamento estiver ativado)
    const listVersionsCommand = new ListObjectVersionsCommand({ Bucket: bucketName });
    const versionsData = await s3Client.send(listVersionsCommand);
    
    const objectsToDelete = [];

    if (versionsData.Versions) {
        versionsData.Versions.forEach(version => {
            objectsToDelete.push({ Key: version.Key, VersionId: version.VersionId });
        });
    }

    if (versionsData.DeleteMarkers) {
        versionsData.DeleteMarkers.forEach(marker => {
            objectsToDelete.push({ Key: marker.Key, VersionId: marker.VersionId });
        });
    }

    if (objectsToDelete.length === 0) {
        return;
    }

    // Dividir em lotes de 1000 (limite do S3)
    const BATCH_SIZE = 1000;
    for (let i = 0; i < objectsToDelete.length; i += BATCH_SIZE) {
        const batch = objectsToDelete.slice(i, i + BATCH_SIZE);
        const deleteCommand = new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
                Objects: batch,
                Quiet: true
            }
        });
        await s3Client.send(deleteCommand);
    }
}

// Nova Rota para deletar um bucket
app.delete('/bucket/:bucketName/delete', express.json(), async (req, res) => {
    const { bucketName } = req.params;

    if (!bucketName) {
        return res.status(400).json({ error: 'Nome do bucket é obrigatório.' });
    }

    try {
        // Verificar se o bucket existe
        const headCommand = new HeadBucketCommand ({ Bucket: bucketName});
        await s3Client.send(headCommand).catch(err => {
            if (err.name === 'NotFound' || err.Code === 'NotFound') {
                throw { code: 'NoSuchBucket', message: `O bucket '${bucketName}' não existe.` };
            } else {
                throw err;
            }
        });

        // Esvaziar o bucket antes de deletá-lo
        await emptyBucket(bucketName);

        // Deletar o bucket
        const deleteBucketCommand = new DeleteBucketCommand({ Bucket: bucketName });
        await s3Client.send(deleteBucketCommand);

        res.status(200).json({ message: `Bucket '${bucketName}' deletado com sucesso.` });
    } catch (error) {
        console.error(error);

        if (error.code === 'NoSuchBucket') {
            return res.status(404).json({ error: error.message });
        }

        // Erro relacionado à permissão
        if (error.name === 'Forbidden' || error.Code === 'AccessDenied') {
            return res.status(403).json({ error: 'Permissão negada para deletar o bucket.' });
        }

        // Outros erros
        res.status(500).json({ error: 'Erro ao deletar o bucket.' });
    }
});

// Rota para fazer upload de um objeto
app.post('/bucket/object/upload', upload.single('file'), async (req, res) => {
   
    const { bucketName,prefix} = req.body;
    
    console.log(prefix);
    
    const file = req.file;

    if (!bucketName || !file) {
        return res.status(400).json({ error: 'Nome do bucket e arquivo são obrigatórios.' });
    }

    try {
        console.log(prefix ?`${prefix}${file.originalname}`:`${file.originalname}`);
        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: prefix ?`${prefix}${file.originalname}`:`${file.originalname}`,
            Body: file.buffer,
        });
        await s3Client.send(command);
        res.status(200).json({ message: `Arquivo '${file.originalname}' enviado para o bucket '${bucketName}'.` });
    } catch (error) {
        console.error(error);

        // Verifica se o erro é devido a um bucket inexistente
        if (error.name === 'NoSuchBucket' || error.Code === 'NoSuchBucket') {
            return res.status(404).json({ error: `O bucket '${bucketName}' não existe.` });
        }

        res.status(500).json({ error: 'Erro ao enviar o arquivo.' });
    }
});

// Rota para listar todos os buckets
app.get('/buckets', async (req, res) => {

    const {name} = req.query;
   
    try {

        const command = new ListBucketsCommand({});
        const data = await s3Client.send(command);
        const buckets = data.Buckets ? data.Buckets.map(bucket => ({
            name: bucket.Name,
            creationDate: bucket.CreationDate
        })) : []; 

        if(name){
           const bucketsfilter = buckets.filter(bucket => bucket.name.toLowerCase().includes(name.trim().toLowerCase()));
           res.status(200).json({ buckets:bucketsfilter }); 
        }else{
            res.status(200).json({ buckets });
        }

        
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao listar os buckets.' });
    }
});

function buildDirectoryTree(contents) {
    const root = { name: "root", isFile: false, children: [] };

    contents.forEach(item => {
        // Remove a barra final se existir e divide por '/'
        const parts = item.name.replace(/\/$/, '').split('/').filter(part => part !== '');
        let current = root;

        parts.forEach((part, index) => {
            const isLast = index === parts.length - 1;
            const isFile = isLast ? item.isFile : false;

            // Procura se o diretório ou arquivo já existe
            let existing = current.children.find(child => child.name === part);

            if (!existing) {
                existing = { name: part, isFile: isFile };
                if (!isFile) {
                    existing.children = [];
                }
                current.children.push(existing);
            }

            current = existing;
        });
    });

    return root;
}


// Rota para listar objetos em um bucket
app.get('/bucket/:bucketName/objects', async (req, res) => {
    const { bucketName } = req.params;
    const { prefix } = req.query;

    if (!bucketName) {
        return res.status(400).json({ error: 'Nome do bucket é obrigatório.' });
    }

    try {
        
        const params = {
            Bucket: bucketName,
            Delimiter: '/', // Delimita apenas children imediatos
        };

        if (prefix) {
            params.Prefix = prefix.endsWith('/') ? prefix : `${prefix}/` // Define o prefixo para consulta
        }

        const command = new ListObjectsV2Command(params);
        const data = await s3Client.send(command);
   
        const commonPrefixes = data.CommonPrefixes
            ? data.CommonPrefixes.map(cp => ({
                name: cp.Prefix.replace(params.Prefix || '', '').replace(/\/$/, ''),
                isFile: false
            }))
            : [];

        const contents = data.Contents
            ? data.Contents
                .filter(obj => obj.Key !== (params.Prefix || '')) // Exclui o diretório atual
                .map(content => ({
                    name: content.Key.replace(params.Prefix || '', ''),
                    isFile: true
                }))
            : [];

        const children = [...commonPrefixes, ...contents];

        res.status(200).json({
            name: params.Prefix || '',
            isFile: false,
            children
        });
    } catch (error) {
        console.error(error);
        // Verifica se o erro é devido a um bucket inexistente
        if (error.name === 'NoSuchBucket' || error.Code === 'NoSuchBucket') {
            return res.status(404).json({ error: `O bucket '${bucketName}' não existe.` });
        }
        res.status(500).json({ message: 'Erro ao listar os objetos.' });
    }
});

// Rota para deletar um objeto ou pasta de um bucket
app.delete('/bucket/:bucketName/object', express.json(), async (req, res) => {
    const { bucketName } = req.params;
    const {objectKey} = req.body;

    console.log('objectKey: ',objectKey);

    if (!bucketName || !objectKey) {
        return res.status(400).json({ error: 'Nome do bucket e chave do objeto são obrigatórios.' });
    }

    try {

        // Listar objetos dentro da pasta
        const listCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: objectKey,
        });

        const listResponse = await s3Client.send(listCommand);

        if (!listResponse.Contents || listResponse.Contents.length === 0) {
            // Objeto ou pasta não encontrado
            return res.status(404).json({ error: `O objeto ou pasta '${objectKey}' não existe no bucket '${bucketName}'.` });
        }

        // Deletar todos os objetos encontrados
        for (const item of listResponse.Contents) {
            const deleteCommand = new DeleteObjectCommand({
                Bucket: bucketName,
                Key: item.Key,
            });

            console.log(`Deletando: ${item.Key}`);
            await s3Client.send(deleteCommand);
        }

        res.status(200).json({ message: `Objeto ou pasta '${objectKey}' deletado do bucket '${bucketName}' com sucesso.` });
    } catch (error) {
        console.error(error);

        // Erro de bucket inexistente
        if (error.name === 'NoSuchBucket' || error.Code === 'NoSuchBucket') {
            return res.status(404).json({ error: `O bucket '${bucketName}' não existe.` });
        }

        // Erro de chave inexistente
        if (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey') {
            return res.status(404).json({ error: `O objeto '${objectKey}' não existe no bucket '${bucketName}'.` });
        }

        res.status(500).json({ error: 'Erro ao deletar o objeto ou pasta.' });
    }
});

// Rota para fazer download de um objeto
app.get('/bucket/:bucketName/object/:objectKey/download', async (req, res) => {
    const { bucketName, objectKey } = req.params;

    if (!bucketName || !objectKey) {
        return res.status(400).json({ error: 'Nome do bucket e chave do objeto são obrigatórios.' });
    }

    try {
        const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: objectKey,
        });
        const data = await s3Client.send(command);

        // Converter o stream em buffer
        const passThrough = new stream.PassThrough();
        data.Body.pipe(passThrough);

        res.setHeader('Content-Disposition', `attachment; filename=${objectKey}`);
        passThrough.pipe(res);
    } catch (error) {
        console.error(error);

        // Verifica se o erro é devido a um bucket inexistente
        if (error.name === 'NoSuchBucket' || error.Code === 'NoSuchBucket') {
            return res.status(404).json({ error: `O bucket '${bucketName}' não existe.` });
        }

        // Verifica se o erro é devido a um objeto inexistente
        if (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey') {
            return res.status(404).json({ error: `O objeto '${objectKey}' não existe no bucket '${bucketName}'.` });
        }

        res.status(500).json({ error: 'Erro ao baixar o arquivo.' });
    }
});

// Rota para criar uma pasta em um bucket
app.post('/bucket/folder/create', async (req, res) => {

    const { bucketName,folderName, key } = req.body;

    console.log(`bucketName:${bucketName} folderName:${folderName} key:${key}`)

    if (!bucketName || !folderName) {
        return res.status(400).json({ error: 'Nome do bucket e nome da pasta são obrigatórios.' });
    }

    // Construir o caminho completo da pasta
    let folderKey = '';
    if (key) {
        // Assegurar que key termina com '/'
        folderKey = key.endsWith('/') ? key : `${key}/`;
    }
    folderKey += folderName.endsWith('/') ? folderName : `${folderName}/`;

    console.log(`folderKey: ${folderKey}`)

    try {
        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: folderKey,
            Body: Buffer.from(''), // Corpo vazio para representar uma pasta
        });
        await s3Client.send(command);
        res.status(201).json({ message: `Pasta '${folderKey}' criada no bucket '${bucketName}'.` });
    } catch (error) {
        console.error(error);

        // Verifica se o erro é devido a um bucket inexistente
        if (error.name === 'NoSuchBucket' || error.Code === 'NoSuchBucket') {
            return res.status(404).json({ error: `O bucket '${bucketName}' não existe.` });
        }

        res.status(500).json({ error: 'Erro ao criar a pasta.' });
    }
});

function isDirectory(key) {
    return key.endsWith('/');
}

function isFile(key) {
    console.log(key);
    return !key.endsWith('/');
}

    // Função para criar buckets, pastas e fazer upload de arquivos
async function initializeBucketsAndFolders(baseDir) {
        if (!fs.existsSync(baseDir)) {
            console.error(`Diretório base '${baseDir}' não encontrado.`);
            return;
        }

    // Ler todos os subdiretórios em baseDir
    const buckets = await util.promisify(fs.readdir)(baseDir, { withFileTypes: true });

    for (const bucket of buckets) {
        if (bucket.isDirectory()) {
            const bucketName = bucket.name;
            console.log(`Criando bucket: ${bucketName}`);

            try {
                // Verificar se o bucket já existe
                const existingBucketsCommand = new ListBucketsCommand({});
                const existingBuckets = await s3Client.send(existingBucketsCommand);

                if (existingBuckets.Buckets.some(b => b.Name === bucketName)) {
                    console.log(`Bucket '${bucketName}' já existe. Pulando...`);
                } else {
                    // Criar o bucket
                    const createBucketCommand = new CreateBucketCommand({ Bucket: bucketName });
                    await s3Client.send(createBucketCommand);
                    console.log(`Bucket '${bucketName}' criado.`);
                }

                // Criar pastas e fazer upload de arquivos
                const bucketPath = path.join(baseDir, bucketName);
                const items = await util.promisify(fs.readdir)(bucketPath, { withFileTypes: true });

                for (const item of items) {
                    const itemPath = path.join(bucketPath, item.name);

                    if (item.isDirectory()) {
                        const folderKey = `${item.name}/`;
                        console.log(`Criando pasta '${folderKey}' no bucket '${bucketName}'.`);

                        const createFolderCommand = new PutObjectCommand({
                            Bucket: bucketName,
                            Key: folderKey,
                            Body: Buffer.from('') // Representação de pasta no S3
                        });
                        await s3Client.send(createFolderCommand);

                        // Verificar arquivos dentro da subpasta
                        const subItems = await util.promisify(fs.readdir)(itemPath, { withFileTypes: true });

                        for (const subItem of subItems) {
                            if (subItem.isFile()) {
                                const filePath = path.join(itemPath, subItem.name);
                                const fileKey = `${item.name}/${subItem.name}`;
                                console.log(`Fazendo upload de arquivo '${fileKey}' no bucket '${bucketName}'.`);

                                const fileBuffer = fs.readFileSync(filePath);
                                const uploadFileCommand = new PutObjectCommand({
                                    Bucket: bucketName,
                                    Key: fileKey,
                                    Body: fileBuffer
                                });
                                await s3Client.send(uploadFileCommand);
                            }
                        }
                    } else if (item.isFile()) {
                        // Upload de arquivo na raiz do bucket
                        const filePath = itemPath;
                        const fileKey = item.name;
                        console.log(`Fazendo upload de arquivo '${fileKey}' no bucket '${bucketName}'.`);

                        const fileBuffer = fs.readFileSync(filePath);
                        const uploadFileCommand = new PutObjectCommand({
                            Bucket: bucketName,
                            Key: fileKey,
                            Body: fileBuffer
                        });
                        await s3Client.send(uploadFileCommand);
                    }
                }
            } catch (error) {
                console.error(`Erro ao processar bucket '${bucketName}':`, error);
            }
        }
    }
}

(async () => {
    const baseDir = path.resolve('./files'); // Caminho do diretório base
    await initializeBucketsAndFolders(baseDir); // Inicializa os buckets com base no diretório

    app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
    });
})();

