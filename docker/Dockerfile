# check=skip=FromPlatformFlagConstDisallowed
FROM --platform=linux/amd64 openalpr/openalpr:latest

RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install flask

COPY alpr-server.py /app/alpr-server.py

EXPOSE 8080

# The base image sets ENTRYPOINT ["alpr"]; reset it so we can run Python directly.
ENTRYPOINT []
CMD ["python3", "/app/alpr-server.py"]
