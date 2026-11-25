// VORTEX File Upload Service: Jenkins pipeline
//
//   GitHub push -> Checkout -> Test -> Build image -> Push image -> Deploy -> Verify
//
// The Jenkins agent needs Docker and kubectl. Add these in
// Manage Jenkins -> Credentials (the IDs must match):
//   dockerhub          Username with password   Docker Hub user + access token
//   kubeconfig         Secret file              kubeconfig of your cluster
//   vortex-secret-key  Secret text              any long random string (signs logins)
//   minio-root         Username with password   MinIO admin user + password (8+ characters)

pipeline {
    agent any

    parameters {
        choice(name: 'STORAGE_MODE', choices: ['pvc', 'emptydir', 'minio'],
               description: 'pvc = files survive a pod delete, emptydir = files are lost, minio = object storage')
    }

    triggers {
        githubPush()   // runs when GitHub's webhook calls http://<jenkins>/github-webhook/
    }

    environment {
        IMAGE = 'your-dockerhub-user/vortex-file-upload'   // <- change to your Docker Hub repo
        TAG   = "${env.BUILD_NUMBER}"
    }

    options {
        timeout(time: 20, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '10'))
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Test') {
            steps {
                // Runs the pytest suite inside Docker (the "test" stage of the Dockerfile).
                sh 'docker build --target test -t vortex-test:$TAG .'
            }
        }

        stage('Build image') {
            steps {
                sh 'docker build -t $IMAGE:$TAG -t $IMAGE:latest .'
            }
        }

        stage('Push image') {
            steps {
                withCredentials([usernamePassword(credentialsId: 'dockerhub',
                                                  usernameVariable: 'DOCKER_USER',
                                                  passwordVariable: 'DOCKER_PASS')]) {
                    sh '''
                        echo "$DOCKER_PASS" | docker login -u "$DOCKER_USER" --password-stdin
                        docker push $IMAGE:$TAG
                        docker push $IMAGE:latest
                        docker logout
                    '''
                }
            }
        }

        stage('Deploy') {
            steps {
                withCredentials([file(credentialsId: 'kubeconfig', variable: 'KUBECONFIG'),
                                 string(credentialsId: 'vortex-secret-key', variable: 'SECRET_KEY'),
                                 usernamePassword(credentialsId: 'minio-root',
                                                  usernameVariable: 'MINIO_USER',
                                                  passwordVariable: 'MINIO_PASS')]) {
                    sh '''
                        kubectl apply -f k8s/namespace.yaml

                        # Secret built from Jenkins credentials, so no password is stored in Git
                        kubectl -n vortex create secret generic vortex-secret \
                          --from-literal=SECRET_KEY="$SECRET_KEY" \
                          --from-literal=MINIO_ROOT_USER="$MINIO_USER" \
                          --from-literal=MINIO_ROOT_PASSWORD="$MINIO_PASS" \
                          --dry-run=client -o yaml | kubectl apply -f -

                        kubectl apply -f k8s/service.yaml

                        # Apply the chosen mode's files, using the image this build just pushed
                        for f in k8s/$STORAGE_MODE/*.yaml; do
                          sed "s|vortex-file-upload:latest|$IMAGE:$TAG|" "$f" | kubectl apply -f -
                        done
                    '''
                }
            }
        }

        stage('Verify') {
            steps {
                withCredentials([file(credentialsId: 'kubeconfig', variable: 'KUBECONFIG')]) {
                    sh '''
                        kubectl -n vortex rollout status deployment/vortex --timeout=180s
                        kubectl -n vortex get pods,svc,pvc

                        # Ask the new pod for /health: shows the pod name and storage mode
                        kubectl -n vortex exec deploy/vortex -- python -c \
                          "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/health').read().decode())"
                    '''
                }
            }
        }
    }

    post {
        success {
            echo "Deployed ${env.IMAGE}:${env.TAG} in ${params.STORAGE_MODE} mode. Open http://<node-ip>:30080"
        }
        failure {
            echo 'Pipeline failed: open the red stage above to see why.'
        }
        always {
            sh 'docker image rm vortex-test:$TAG || true'
        }
    }
}
